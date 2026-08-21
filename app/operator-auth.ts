import { getChatGPTUser, type ChatGPTUser } from "./chatgpt-auth";

const ALLOWED_OPERATOR_IDS = new Set([
  "e1b7f410-753a-4627-ac80-3690c7ce9f51",
]);

const LOCAL_OPERATOR: ChatGPTUser = {
  userId: "local-development",
  displayName: "Local operator",
  email: "local@meridian.invalid",
  fullName: "Local operator",
};

export function isOperatorUser(user: ChatGPTUser) {
  return ALLOWED_OPERATOR_IDS.has(user.userId);
}

export async function getOperatorUser(): Promise<ChatGPTUser | null> {
  if (process.env.NODE_ENV === "development") return LOCAL_OPERATOR;
  const user = await getChatGPTUser();
  return user && isOperatorUser(user) ? user : null;
}
