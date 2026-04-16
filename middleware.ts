// 路由鉴权中间件
import { auth } from "@/auth"
import { NextResponse } from "next/server"

export default auth((req) => {
    const { pathname } = req.nextUrl
    const isLoggedIn = !!req.auth

    // 检查是否是公开路由
    const publicRoutes = ['/api/auth', '/login']
    const isPublicRoute = publicRoutes.some((route) => pathname.startsWith(route))

    // 如果已登陆用户访问登录页，返回首页
    if(isLoggedIn&&pathname==='/login'){
        // next中间件运行在边缘环境，不知道当前网站完整域名,req.url拿到域名，拼接目标路径成完整url
        return NextResponse.redirect(new URL('/',req.url))
    }

    // 未登录用户访问非公开路由
    if(!isLoggedIn&&!isPublicRoute){
        return NextResponse.redirect(new URL('/login',req.url))
    }

    return NextResponse.next()
})

export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}