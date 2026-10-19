import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn("h-10 w-full min-w-0 rounded-md border border-input bg-card px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:text-sm", className)} {...props} />;
}
