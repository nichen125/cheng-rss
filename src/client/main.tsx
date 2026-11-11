import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ConfirmProvider } from './components/ConfirmDialog.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './styles.css';
import './mobile.css';
import './feeds.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root 缺失');

// ConfirmProvider 挂在 StrictMode 之内、App 之外：确认弹窗是应用级能力，
// 配置弹窗（SettingsModal）与主界面都要用，谁都不该自己再包一层 ——
// 嵌套两个 Provider 会让内层拿到另一个实例，排队与焦点管理就各管各的。

// 根部这层是最后的兜底：它包在 ConfirmProvider 之外，所以 Provider 自身或
// App 里任何一处 render 期抛异常都还有面板可看，而不是白屏。兜底 UI 用不到
// confirm，放在外面才不会一起被卷进去。
createRoot(el).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
