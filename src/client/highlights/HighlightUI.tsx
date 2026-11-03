import { useEffect, useRef, useState } from 'react';
import type { HighlightItem } from '../api.ts';
import { COLORS, COLOR_LABEL, type HighlightColor } from './text-map.ts';

// 划词工具条 + 本文高亮列表（PLAN §11.3）。
//
// 两个刻意的取舍：
//   · 工具条只有 4 个按钮（黄/绿/蓝/批注），不做调色盘。§11.3 的原话是
//     "选择过载会让人不用" —— 一旦有 12 种颜色，用户每次都要想"用哪个"。
//   · 列表**包含 orphaned**，单独一段「原文已变化」。§11.1 的硬要求是
//     不静默丢，而"丢了一半"最常见的表现就是列表里看不见它们。

export function HighlightToolbar(props: {
  x: number;
  y: number;
  onPick: (color: HighlightColor) => void;
  onAnnotate: (note: string) => void;
}) {
  // 批注在工具条内联展开，不用 window.prompt（§11.3 修订）。
  //
  // 为什么换掉 prompt：它是浏览器原生模态框，样式完全不受控 —— 在暗色主题下
  // 会弹出一块纯白方块，而且**无法取消已输入的文本**（原生 prompt 的"取消"
  // 只返回 null，用户看不到自己写了什么被丢掉）。内联输入框的取消就是在
  // 工具条里点「取消」，与界面其余部分同一套语言。
  const [note, setNote] = useState<string | null>(null);

  // 工具条贴着选区上方浮出。用 transform 居中而不是算 left = x - width/2：
  // 宽度随语言/字号变化，算死值在对齐上会差几个像素。
  return (
    <div
      className="hl-toolbar"
      style={{ left: props.x, top: props.y }}
      // mousedown 阻止默认行为：不这么做的话点按钮会让选区先消失，
      // 而我们正是要在选区还有效时提交它
      onMouseDown={(e) => e.preventDefault()}
    >
      {note === null ? (
        <>
          {COLORS.map((c) => (
            <button
              key={c}
              className={`hl-swatch hl-swatch-${c}`}
              title={`${COLOR_LABEL[c]}色高亮（快捷键 ${c === 'yellow' ? 'h' : c === 'green' ? 'g' : 'b'}）`}
              onClick={() => props.onPick(c)}
            />
          ))}
          <span className="hl-sep" aria-hidden="true" />
          <button className="hl-action" onClick={() => setNote('')} title="加批注（快捷键 n）">
            批注
          </button>
        </>
      ) : (
        <div className="hl-annotate">
          <input
            autoFocus
            value={note}
            placeholder="这条为什么重要？"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { props.onAnnotate(note.trim()); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNote(null); }
            }}
          />
          <button
            className="hl-action"
            onClick={() => setNote(null)}
            title="取消（Esc）"
          >
            取消
          </button>
          <button
            className="hl-action primary"
            onClick={() => props.onAnnotate(note.trim())}
            disabled={note.trim().length === 0}
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}

export function HighlightList(props: {
  items: HighlightItem[];
  onScrollTo: (id: string) => void;
  onDelete: (id: string) => void;
  onRecolor: (id: string, color: HighlightColor) => void;
  onSaveNote: (id: string, note: string) => void;
  onInsight: (id: string) => void;
  /** 正在解读哪一条；null = 空闲 */
  insightBusy: string | null;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  const live = props.items.filter((x) => !x.isOrphaned);
  const orphaned = props.items.filter((x) => x.isOrphaned);

  if (props.items.length === 0) {
    return (
      <div className="hl-empty">
        选中正文里的任意一段即可高亮。高亮会跟着正文重新提取自动重新定位。
      </div>
    );
  }

  return (
    <div className="hl-list">
      {live.length > 0 && (
        <ul className="hl-group">
          {live.map((h) => (
            <HighlightCard
              key={h.id}
              h={h}
              editing={editing === h.id}
              onEdit={() => setEditing(editing === h.id ? null : h.id)}
              onScrollTo={() => props.onScrollTo(h.id)}
              onDelete={() => props.onDelete(h.id)}
              onRecolor={(c) => props.onRecolor(h.id, c)}
              onSaveNote={(n) => props.onSaveNote(h.id, n)}
              onInsight={() => props.onInsight(h.id)}
              insightBusy={props.insightBusy === h.id}
            />
          ))}
        </ul>
      )}

      {orphaned.length > 0 && (
        <>
          {/* 这一段必须显式存在。用户看到"原文已变化，无法定位"至少知道
              自己标过；静默丢掉的话他会以为是自己记错了。 */}
          <div className="hl-orphan-head">
            原文已变化，无法定位（{orphaned.length}）
          </div>
          <ul className="hl-group hl-group-orphan">
            {orphaned.map((h) => (
              <HighlightCard
                key={h.id}
                h={h}
                editing={editing === h.id}
                onEdit={() => setEditing(editing === h.id ? null : h.id)}
                onScrollTo={() => { /* 没有位置，滚不过去 */ }}
                onDelete={() => props.onDelete(h.id)}
                onRecolor={(c) => props.onRecolor(h.id, c)}
                onSaveNote={(n) => props.onSaveNote(h.id, n)}
              onInsight={() => props.onInsight(h.id)}
              insightBusy={props.insightBusy === h.id}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function HighlightCard(props: {
  h: HighlightItem;
  editing: boolean;
  onEdit: () => void;
  onScrollTo: () => void;
  onDelete: () => void;
  onRecolor: (c: HighlightColor) => void;
  onSaveNote: (note: string) => void;
  onInsight: () => void;
  insightBusy: boolean;
}) {
  const { h } = props;
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState(h.note ?? '');

  useEffect(() => { setNote(h.note ?? ''); }, [h.note]);
  useEffect(() => {
    if (props.editing) noteRef.current?.focus();
  }, [props.editing]);

  // 进编辑态时把草稿对齐到当前值；退出时丢弃未保存的改动。
  // 不这么做的话：改了一半、点「取消」，再点「加批注」会看到上次的草稿，
  // 用户以为"取消没生效"。取消的语义就是丢弃。
  const cancel = () => {
    setNote(h.note ?? '');
    props.onEdit();
  };

  return (
    <li className={`hl-card${h.isOrphaned ? ' is-orphaned' : ''}`}>
      <button
        className="hl-quote"
        onClick={props.onScrollTo}
        disabled={h.isOrphaned}
        title={h.isOrphaned ? '原文已变化' : '跳到这一处'}
      >
        <span className={`hl-dot hl-dot-${h.color ?? 'yellow'}`} aria-hidden="true" />
        <span className="hl-quote-text">{h.quote}</span>
      </button>

      {props.editing ? (
        <div className="hl-edit">
          <textarea
            ref={noteRef}
            value={note}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // Esc 退出编辑（与 Esc 关闭浮层/返回列表一致）
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
            }}
            placeholder="这条为什么重要？"
          />
          <div className="hl-edit-actions">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`hl-swatch hl-swatch-${c}${(h.color ?? 'yellow') === c ? ' active' : ''}`}
                title={COLOR_LABEL[c]}
                onClick={() => props.onRecolor(c)}
              />
            ))}
            <span className="spacer" />
            <button className="btn sm" onClick={props.onDelete}>删除</button>
            <button className="btn sm" onClick={cancel}>取消</button>
            <button
              className="btn sm primary"
              onClick={() => { props.onSaveNote(note); props.onEdit(); }}
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <>
          {h.aiInsight && (
            <div className="hl-insight">
              <span className="hl-insight-tag">AI</span>
              {h.aiInsight}
            </div>
          )}
          {h.note && <p className="hl-note">{h.note}</p>}
          <div className="hl-actions">
            <button className="hl-edit-link" onClick={props.onEdit}>
              {h.note ? '编辑批注' : '加批注'}
            </button>
            {!h.aiInsight && !h.isOrphaned && (
              <button
                className="hl-edit-link"
                onClick={props.onInsight}
                disabled={props.insightBusy}
                title="让 AI 解释这段话为什么值得注意"
              >
                {props.insightBusy ? '解读中…' : 'AI 解读'}
              </button>
            )}
          </div>
        </>
      )}
    </li>
  );
}
