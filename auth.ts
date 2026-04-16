import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import Google from "next-auth/providers/google"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "@/lib/db"

export const {handlers,auth,signIn,signOut}=NextAuth({
    adapter:PrismaAdapter(prisma),
    providers:[
        GitHub
    ],
    session:{
        strategy:"jwt"//使用jwt减少数据库查询
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
    }
})