import { signIn } from "@/auth"

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-4 p-6">
        <h1 className="text-2xl font-bold text-center">登录</h1>
        <form
          action={async () => {
            "use server"
            await signIn("github")
          }}
        >
          <button type="submit" className="w-full rounded-md bg-gray-900 text-white py-2 px-4">
            使用 GitHub 登录
          </button>
        </form>
        <form
          action={async () => {
            "use server"
            await signIn("google")
          }}
        >
          <button type="submit" className="w-full rounded-md border border-gray-300 py-2 px-4">
            使用 Google 登录
          </button>
        </form>
      </div>
    </div>
  )
}