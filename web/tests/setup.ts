/** Bun test 预载：注册 Happy DOM（视图/组件测试需要真实 DOM 语义）。 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register({ url: "http://127.0.0.1:7788/" });
}
