// React 版图标组件：DOM 与 icons.js 的 ic() 输出逐属性一致
import { iconBody } from "./icons.js";

export function Ic({ name, size = 16, cls = "" }) {
  const body = iconBody(name);
  if (!body) return null;
  return (
    <svg
      className={"ic" + (cls ? " " + cls : "")}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}
