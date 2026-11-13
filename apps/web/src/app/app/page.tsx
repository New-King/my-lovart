import { RequireAuth } from "@/components/require-auth";
import { ToastProvider } from "@/components/ui/toast";
import { Workspace } from "@/components/workspace";

export default function Page() {
  return (
    <RequireAuth>
      <ToastProvider>
        <Workspace />
      </ToastProvider>
    </RequireAuth>
  );
}