/** Tailwind is used at BUILD time only. The compiled, minified output is inlined into src/Styles.html. */
module.exports = {
  content: ['src/Index.html', 'src/Scripts*.html', 'src/SharedComponents.html'],
  corePlugins: { preflight: true },
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)', card: 'var(--card)', ink: 'var(--ink)', soft: 'var(--ink-soft)', line: 'var(--line)', hair: 'var(--hair)',
        lime: 'var(--lime)', sky: 'var(--sky)', mint: 'var(--mint)', coral: 'var(--coral)', amber: 'var(--amber)', fill: 'var(--fill)'
      },
      fontFamily: { display: 'var(--f-display)', head: 'var(--f-head)', body: 'var(--f-body)' },
      borderRadius: { card: '12px', ctl: '6px' }
    }
  },
  plugins: []
};
