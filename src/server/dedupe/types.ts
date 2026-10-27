// 去重的公共类型。
//
// 单独成文件的原因：index.ts 与将来的调用方（M3 聚类、doctor）
// 都要用这几个形状，而 index.ts 会 import feeds/parse.ts ——
// 类型放在有副作用的模块里，会让只想拿类型的消费者也被拖进解析器依赖。

export type DuplicateReason = 'url' | 'hash' | 'vector';

export interface DuplicateHit {
  entryId: string;
  reason: DuplicateReason;
  /** 仅 vector 层有值；url/hash 层是完全相同，记 1 */
  similarity: number;
}
