import { handlers } from "@/auth"
// 接收并暴露NextAuth返回的回调函数,auth.ts的入口，所有/auth请求通过这里处理
export const { GET, POST } = handlers