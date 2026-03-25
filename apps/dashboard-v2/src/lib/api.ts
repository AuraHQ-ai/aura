import createClient from "openapi-fetch";
import type { paths } from "./api-types.js";

const baseUrl = import.meta.env.VITE_API_URL ?? "";

export const client = createClient<paths>({
  baseUrl,
  headers: {
    "Content-Type": "application/json",
  },
});

client.use({
  onRequest({ request }) {
    const token = localStorage.getItem("aura_session");
    if (token) {
      request.headers.set("Authorization", `Bearer ${token}`);
    }
    return request;
  },
});
