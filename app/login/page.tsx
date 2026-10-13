"use client"

import { signIn } from "next-auth/react"

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-4 p-6">
        <h1 className="text-2xl font-bold text-center">登录</h1>
        <button
          type="button"
          onClick={() => {
            void signIn("github", { callbackUrl: "/" })
          }}
          className="w-full rounded-md bg-gray-900 text-white py-2 px-4 hover:cursor-pointer"
        >
          使用 GitHub 登录
        </button>
      </div>
    </div>
  )
}