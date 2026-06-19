/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          950: '#0e0e0e', // Pure dark
          900: '#101010', // Page BG
          800: '#151717', // Card BG
          700: '#1A1C1C', // Hover
          600: '#2A2D2D',
        },
        cyan: {
          400: '#00a79e', // Deriv Teal/Win
          500: '#008a82',
        },
        amber: {
          400: '#ff8c00',
          500: '#e07b00',
        },
        crimson: {
          500: '#ff444f', // Deriv Coral/Loss
          600: '#e03a43',
        },
        emerald: {
          400: '#00a79e', // Remapped to Deriv Teal
          500: '#008a82',
        },
      },
      fontFamily: {
        display: ['Syne', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
        body: ['DM Sans', 'sans-serif'],
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'slide-in': 'slide-in 0.3s ease-out',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        'slide-in': {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
