/* Supabase browser configuration.
   Publishable keys are designed for browser use when RLS is enabled.
   NEVER put a Supabase Secret/Service Role key in this file. */
(function () {
  const SUPABASE_URL = 'https://nwvpdnpqrnconrztfpav.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_5RUnB64u1krx4SGc7dhx1A_4A62SC-U';

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('Supabase library did not load.');
    window.supabaseClient = null;
    return;
  }

  try {
    window.supabaseClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY
    );
    console.log('Supabase client ready');
  } catch (error) {
    console.error('Supabase client initialization failed:', error);
    window.supabaseClient = null;
  }
})();
