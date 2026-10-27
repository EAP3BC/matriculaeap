/* ============================================================
   CONFIG.JS — Conexão com o MESMO projeto Supabase.
   Nada aqui altera o sistema atual — apenas conecta.
   ============================================================ */

const SUPABASE_URL  = 'https://utcmigsegqskmhhcthso.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0Y21pZ3NlZ3Fza21oaGN0aHNvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4Nzk3ODQsImV4cCI6MjEwODQ1NTc4NH0.Ns5YqsYBIxEMDMbzKs2gcqH4_TQAybQoFiTrt91PxsA';

let sb = null;
try {
  if (window.supabase && SUPABASE_URL.startsWith('https://')){
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  }
} catch(e){ console.warn('Supabase não configurado:', e); }