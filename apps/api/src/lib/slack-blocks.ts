export function cardBlock(params: {
  title: string;
  body: string;
  footer?: string;
}): {
  type: "card";
  title: string;
  body: string;
  footer?: string;
} {
  const { title, body, footer } = params;
  return {
    type: "card",
    title,
    body,
    ...(footer ? { footer } : {}),
  };
}

export function alertBlock(params: {
  level: "info" | "warning" | "error";
  text: string;
}): {
  type: "alert";
  level: "info" | "warning" | "error";
  text: string;
} {
  return {
    type: "alert",
    level: params.level,
    text: params.text,
  };
}
