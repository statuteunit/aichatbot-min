import clsx from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

// 生成唯一 ID
export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}