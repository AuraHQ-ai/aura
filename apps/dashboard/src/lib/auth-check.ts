import { apiPost } from "./api";

interface CheckRoleRequest {
  slackUserId: string;
  name?: string;
  picture?: string;
}

interface CheckRoleResponse {
  allowed: boolean;
  role?: string;
  reason?: string;
  bootstrapped?: boolean;
}

export async function checkRole(
  params: CheckRoleRequest,
): Promise<CheckRoleResponse> {
  return apiPost<CheckRoleResponse>("/auth/check-role", params);
}
