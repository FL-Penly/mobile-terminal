//! Cancellable Unix PTY pumps. Dropping these writers closes their file
//! descriptors without injecting portable-pty's newline + EOF into tmux.
use bytes::Bytes;
use nix::{
    errno::Errno,
    fcntl::{fcntl, FcntlArg, OFlag},
    poll::{poll, PollFd, PollFlags},
};
use portable_pty::MasterPty;
use std::{
    fs::File,
    io::{self, Read, Write},
    net::Shutdown,
    os::{
        fd::{AsRawFd, BorrowedFd, RawFd},
        unix::net::UnixStream,
    },
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tokio::sync::mpsc;

pub(crate) fn files(master: &dyn MasterPty) -> io::Result<(File, File)> {
    let fd = master
        .as_raw_fd()
        .ok_or_else(|| io::Error::other("PTY has no Unix file descriptor"))?;
    // SAFETY: master owns this descriptor and remains borrowed until we duplicate it.
    let owned = unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?;
    let file = File::from(owned);
    let flags = OFlag::from_bits_truncate(fcntl(fd, FcntlArg::F_GETFL)?);
    fcntl(fd, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))?;
    Ok((file.try_clone()?, file))
}

pub(crate) struct Cancel {
    stopped: Arc<AtomicBool>,
    notify: UnixStream,
}

impl Cancel {
    pub(crate) fn cancel(&self) {
        self.stopped.store(true, Ordering::Release);
        // EOF remains readable by both pumps; there is no periodic idle polling.
        let _ = self.notify.shutdown(Shutdown::Write);
    }
}

impl Drop for Cancel {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Clone)]
pub(crate) struct Waiter {
    stopped: Arc<AtomicBool>,
    wake: Arc<UnixStream>,
}

pub(crate) fn cancellation() -> io::Result<(Cancel, Waiter)> {
    let (notify, wake) = UnixStream::pair()?;
    let stopped = Arc::new(AtomicBool::new(false));
    Ok((
        Cancel {
            stopped: stopped.clone(),
            notify,
        },
        Waiter {
            stopped,
            wake: Arc::new(wake),
        },
    ))
}

impl Waiter {
    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    fn wait(&self, fd: RawFd, event: PollFlags) -> bool {
        loop {
            if self.stopped() {
                return false;
            }
            let mut descriptors = [
                PollFd::new(fd, event),
                PollFd::new(self.wake.as_raw_fd(), PollFlags::POLLIN),
            ];
            match poll(&mut descriptors, -1) {
                Ok(_) => {
                    return !self.stopped()
                        && descriptors[1]
                            .revents()
                            .unwrap_or_else(PollFlags::empty)
                            .is_empty()
                        && !descriptors[0]
                            .revents()
                            .unwrap_or_else(PollFlags::empty)
                            .contains(PollFlags::POLLNVAL)
                }
                Err(Errno::EINTR) => continue,
                Err(_) => return false,
            }
        }
    }
}

pub(crate) fn read_loop(
    mut reader: File,
    output: mpsc::Sender<Bytes>,
    paused: Arc<(Mutex<bool>, Condvar)>,
    waiter: Waiter,
) {
    let mut buf = [0u8; 65536];
    while !waiter.stopped() {
        let (lock, cvar) = &*paused;
        let Ok(is_paused) = lock.lock() else { break };
        if *is_paused {
            let Ok((mut is_paused, _)) = cvar.wait_timeout(is_paused, Duration::from_secs(2))
            else {
                break;
            };
            if *is_paused {
                tracing::warn!("Flow control: auto-resuming after 2s timeout");
                *is_paused = false;
            }
        } else {
            drop(is_paused);
        }
        if waiter.stopped() {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if output
                    .blocking_send(Bytes::copy_from_slice(&buf[..n]))
                    .is_err()
                {
                    break;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if !waiter.wait(reader.as_raw_fd(), PollFlags::POLLIN) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

pub(crate) fn write_loop(mut writer: File, mut input: mpsc::Receiver<Bytes>, waiter: Waiter) {
    while let Some(data) = input.blocking_recv() {
        let mut offset = 0;
        while offset < data.len() {
            if waiter.stopped() {
                return;
            }
            match writer.write(&data[offset..]) {
                Ok(0) => return,
                Ok(n) => offset += n,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if !waiter.wait(writer.as_raw_fd(), PollFlags::POLLOUT) {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::fd::OwnedFd, thread};

    fn socket_file() -> (File, UnixStream) {
        let (writer, reader) = UnixStream::pair().unwrap();
        writer.set_nonblocking(true).unwrap();
        (File::from(OwnedFd::from(writer)), reader)
    }

    #[tokio::test]
    async fn writer_preserves_bytes_across_partial_writes_and_backpressure() {
        let (file, mut peer) = socket_file();
        let (cancel, waiter) = cancellation().unwrap();
        let (tx, rx) = mpsc::channel(4);
        let data: Vec<u8> = (0..2 * 1024 * 1024).map(|n| (n % 251) as u8).collect();
        let length = data.len();
        let writer = thread::spawn(move || write_loop(file, rx, waiter));
        let reader = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            let mut actual = vec![0; length];
            peer.read_exact(&mut actual).unwrap();
            actual
        });
        for chunk in data.chunks(8192) {
            tx.send(Bytes::copy_from_slice(chunk)).await.unwrap();
        }
        drop(tx);
        let actual = tokio::task::spawn_blocking(move || {
            writer.join().unwrap();
            reader.join().unwrap()
        })
        .await
        .unwrap();
        assert_eq!(actual, data);
        drop(cancel);
    }

    #[tokio::test]
    async fn cancelling_unblocks_a_writer_whose_peer_is_not_reading() {
        let (file, _peer) = socket_file();
        let (cancel, waiter) = cancellation().unwrap();
        let (tx, rx) = mpsc::channel(4);
        let writer = thread::spawn(move || write_loop(file, rx, waiter));
        let pending = tokio::spawn(async move {
            for _ in 0..1024 {
                if tx.send(Bytes::from(vec![42; 8192])).await.is_err() {
                    return;
                }
            }
            panic!("unread socket unexpectedly accepted 8 MiB");
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!pending.is_finished());
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(2), async {
            pending.await.unwrap();
            tokio::task::spawn_blocking(move || writer.join().unwrap())
                .await
                .unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn cancelling_wakes_an_idle_reader_without_a_timeout_tick() {
        let (file, _peer) = socket_file();
        let (cancel, waiter) = cancellation().unwrap();
        let (tx, mut rx) = mpsc::channel(4);
        let paused = Arc::new((Mutex::new(false), Condvar::new()));
        let reader = thread::spawn(move || read_loop(file, tx, paused, waiter));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!reader.is_finished());
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(2), async {
            assert!(rx.recv().await.is_none());
            tokio::task::spawn_blocking(move || reader.join().unwrap())
                .await
                .unwrap();
        })
        .await
        .unwrap();
    }

    #[test]
    fn closing_writer_does_not_inject_newline_or_eof_into_the_pty() {
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let (mut reader, writer) = files(pair.master.as_ref()).unwrap();
        // Keep the slave open in canonical/echo mode. An injected newline would
        // be echoed to the master, even though we never sent user input.
        drop(writer);
        assert_eq!(
            poll(
                &mut [PollFd::new(reader.as_raw_fd(), PollFlags::POLLIN)],
                50
            )
            .unwrap(),
            0
        );
        let mut buf = [0; 32];
        assert_eq!(
            reader.read(&mut buf).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }
}
