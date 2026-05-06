import { createClient } from "@supabase/supabase-js";

function normalizeSupabaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-z0-9]{20}$/i.test(trimmed)) {
    return `https://${trimmed}.supabase.co`;
  }

  return "";
}

const supabaseUrl = normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL);
const supabaseAnonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();

let supabaseClient = null;

if (supabaseUrl && supabaseAnonKey) {
  try {
    supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
  } catch (error) {
    console.error("Supabase configuration error:", error);
  }
}

export const supabase = supabaseClient;
export const isSupabaseConfigured = Boolean(supabaseClient);

export const HOST_PIN = import.meta.env.VITE_HOST_PIN || "411";
