export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-primary': 'var(--bg-primary)',
        'bg-secondary': 'var(--bg-secondary)',
        'bg-tertiary': 'var(--bg-tertiary)',
        'accent-blue': 'var(--accent-blue)',
        'accent-green': 'var(--accent-green)',
        'accent-red': 'var(--accent-red)',
        'accent-purple': 'var(--accent-purple)',
        'accent-orange': 'var(--accent-orange)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
        'border-subtle': 'var(--border-subtle)',
        'tint-blue': 'rgb(var(--tint-blue) / <alpha-value>)',
        'tint-green': 'rgb(var(--tint-green) / <alpha-value>)',
        'tint-red': 'rgb(var(--tint-red) / <alpha-value>)',
        'tint-purple': 'rgb(var(--tint-purple) / <alpha-value>)',
        'tint-orange': 'rgb(var(--tint-orange) / <alpha-value>)',
        'tint-surface': 'rgb(var(--tint-surface) / <alpha-value>)',
      },
    },
  },
  plugins: [],
}
