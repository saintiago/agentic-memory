/**
 * Small DOM builders of the inspection UI. Every value is written with `textContent`, so displayed
 * source text is inert and no note content can become markup.
 *
 * See docs/dashboard.md#visual-behavior.
 */

export interface ElementOptions {
  readonly className?: string;
  readonly text?: string;
  readonly id?: string;
  readonly type?: string;
  readonly value?: string;
  readonly hidden?: boolean;
  readonly title?: string;
}

/** Create one element with text content and no markup from data. */
export const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: ReadonlyArray<Node | string> = [],
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (options.className !== undefined) {
    node.className = options.className;
  }
  if (options.id !== undefined) {
    node.id = options.id;
  }
  if (options.text !== undefined) {
    node.textContent = options.text;
  }
  if (options.hidden !== undefined) {
    node.hidden = options.hidden;
  }
  if (options.title !== undefined) {
    node.title = options.title;
  }
  if (options.type !== undefined) {
    node.setAttribute("type", options.type);
  }
  if (options.value !== undefined) {
    node.setAttribute("value", options.value);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
};

/** Remove every child of one element. */
export const clear = (node: Element): void => {
  while (node.firstChild !== null) {
    node.removeChild(node.firstChild);
  }
};

/** One labeled block of text, used by the details panel. */
export const field = (
  name: string,
  value: string,
  className = "field-value",
): HTMLElement => {
  const wrapper = element("div", { className: "field" });
  wrapper.append(element("span", { className: "field-name", text: name }));
  wrapper.append(element("pre", { className, text: value }));
  return wrapper;
};
