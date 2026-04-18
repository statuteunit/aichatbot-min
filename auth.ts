import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
// import Google from "next-auth/providers/google"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "@/lib/db"

export const {handlers,auth,signIn,signOut}=NextAuth({
    adapter:PrismaAdapter(prisma),
    providers:[
        GitHub
    ],
    session:{
        strategy:"jwt",//使用jwt减少数据库查询
        // 配置持久化过期时间7天
        maxAge: 7 * 24 * 60 * 60
    },
    jwt:{
        maxAge: 7 * 24 * 60 * 60
    },
    callbacks:{
        // 通过内置回调函数接入身份验证流程
        async jwt({token,user}){
            if(user){
                // 将用户id写入token
                token.id=user.id
            }
            return token
        },
        async session({session,token}){
            if(token&&session.user){
                // 将token中的id传递到客户端的session对象
                session.user.id=token.id as string
            }
            return session
        }
    },
    pages:{
        signIn:"/login"
    },
    cookies:{
        sessionToken:{
            name:"next-auth.session-token",
            options:{
                httpOnly:true,
                sameSite:"lax",//同站请求正常携带cookie，从别的网站跳转过来携带cookie，跨站请求不携带
                secure:false,//生产环境需要改为true->https才发送
                maxAge: 7 * 24 * 60 * 60
            }
        }
    }
})