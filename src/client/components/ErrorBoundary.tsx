// 渲染期异常的兜底（错误边界）。
//
// 为什么非得是 class：捕获渲染异常靠的是 getDerivedStateFromError /
// componentDidCatch，React 19 依然没有函数式等价物 —— 这是渲染管线自己
// 提供的钩子，不是随便哪个 effect 能替代的。
//
// 为什么除此之外还要在阅读区单独包一层：根边界一旦触发，替换的是整个
// App，列表、筛选、读到一半的位置全跟着没了，用户只剩刷新一条路。
// 正文解析、目录生成、surroundContents 包高亮都在阅读区里，是最容易抛
// 异常的一段；把它隔在自己的层里，炸的时候列表还在，退一步就能继续读。
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义兜底 UI。reset() 清掉错误状态并重新渲染 children */
  fallback?: (err: Error, reset: () => void) => ReactNode;
  /** 出错的是哪一块，用于控制台定位与默认面板的标题 */
  label?: string;
  /** 「回到列表」用什么动作。根部不传 —— 整棵树崩了没有可回的地方 */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // componentStack 比 message 更能定位是哪次渲染炸的，一起打出来
    console.error(this.props.label ? `【${this.props.label}】渲染异常` : '渲染异常', error, info.componentStack);
  }

  reset = () => { this.setState({ error: null }); };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <CrashPanel
        label={this.props.label}
        error={error}
        reset={this.reset}
        onReset={this.props.onReset}
      />
    );
  }
}

/** 默认兜底面板。写给读文章的人看，不是写给开发者：先说发生了什么、再给下一步 */
function CrashPanel(props: {
  label?: string;
  error: Error;
  reset: () => void;
  onReset?: () => void;
}) {
  const back = props.onReset;
  return (
    <div className="crash" role="alert">
      <h2>{props.label ? `${props.label}没能渲染` : '界面没能渲染'}</h2>
      <p>
        这一块在绘制时抛了异常，不是网络问题。点「重试」会重新渲染一次；
        一直不行就先回到列表，读别的条目。
      </p>
      {/* 错误原文留给用户截图反馈，压成一行小字，不占视线 */}
      {props.error.message && <pre className="crash-detail">{props.error.message}</pre>}
      <div className="crash-actions">
        <button type="button" className="btn" onClick={props.reset}>重试</button>
        {/* 根部没有"列表"可回：App 的视图、筛选、滚动位置都只活在组件 state
            里（不写 URL、不落盘），所以根边界只能 reload 重建整棵树。
            知道怎么退一步的调用方（阅读区）传 onReset，这里复用它。 */}
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            if (back) { back(); props.reset(); } else location.reload();
          }}
        >
          {back ? '回到列表' : '重新加载'}
        </button>
      </div>
    </div>
  );
}
