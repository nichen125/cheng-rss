// 列表视图（侧栏导航的 key）。
//
// 从 App.tsx 搬出来：App 的导航和 EmptyState 的空态文案都要用它，
// 而 components/* 不许反向 import App.tsx —— 放到 lib/ 两边都能拿。

export type View = 'inbox' | 'unread' | 'starred' | 'history' | 'digest';
