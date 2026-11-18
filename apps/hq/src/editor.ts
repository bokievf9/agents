/** Kind-specific approval editing: the owner picks a part (script, one platform) instead of replacing the whole text. */
export interface ApprovalEditor {
  /** "Править" pressed for an approval of this kind: asks which part. Returns the callback toast. */
  press(approvalId: number): Promise<string>;
  /** A part button pressed: the next owner message replaces that part. Returns the toast. */
  pick(approvalId: number, part: string): Promise<string>;
  /** A plain owner message: true when it was the awaited edit text. */
  consume(text: string): Promise<boolean>;
  /** /skip */
  cancel(): void;
}
