import { requestPrincipal, requireKeyScope, type WorkerGrant } from "./principals";
import { ApiError } from "./http";

export async function requireWorker(request: Request, scope: string): Promise<WorkerGrant> {
  const principal = await requestPrincipal(request);
  if (!principal || principal.kind !== "worker-key") throw new ApiError(401, "worker_key_required");
  requireKeyScope(principal.worker, scope);
  return principal.worker;
}
