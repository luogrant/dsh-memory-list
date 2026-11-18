// 记忆识海 · 网页半边（DSH 侧栏入口 + 主区 iframe）
//
// 宿主已经把整套界面挂在 /dsh-memory-list/ 下，这里只负责：
//   · 左侧栏给一个「识海」入口；
//   · 主区用 iframe 装那块页面（同源，cookie/fetch 都省事）。
window.__ModuleLoader__.load({
  id: 'dsh-memory-list',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const 地址 = '/dsh-memory-list/'

    const 图标 = () =>
      h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 } },
        h('span', { 'aria-hidden': 'true', style: { fontSize: 13 } }, '✦'),
        h('span', null, '识海'),
      )

    const 识海 = () =>
      h(
        'div',
        {
          style: {
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: '#0b0f1a',
          },
        },
        h('iframe', {
          src: 地址,
          title: '记忆识海',
          style: { flex: 1, width: '100%', border: 0, background: '#0b0f1a' },
        }),
      )

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'memory-list', order: 21, label: () => '识海' },
            图标,
          ),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'memory-list' }, 识海))
      },
    }
  },
})
