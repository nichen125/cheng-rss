import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ConfirmProvider } from './components/ConfirmDialog.tsx';
import './styles.css';
import './mobile.css';
import './feeds.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root 缺失');

// ConfirmProvider 挂在 StrictMode 之内、App 之外：确认弹窗是应用级能力，
// 配置弹窗（SettingsModal）与主界面都要用，谁都不该自己再包一层 ——
// 嵌套两个 Provider 会让内层拿到另一个实例，排队与焦点管理就各管各的。
createRoot(el).render(
  <React.StrictMode>
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </React.StrictMode>,
);
