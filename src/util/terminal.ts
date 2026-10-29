// terminal.ts — render untrusted text visibly instead of interpreting controls.

/** Escape C0/C1 controls so filenames and source text cannot issue terminal commands. */
export function terminalData(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    const code = char.charCodeAt(0);
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
}

/** Serialize machine-readable output without leaving C1 controls active in a terminal. */
export function terminalJson(value: unknown): string {
  const encoded = JSON.stringify(value, null, 2);
  if (encoded === undefined) throw new TypeError("JSON value is not serializable");
  return encoded.replace(/[\u007f-\u009f]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
