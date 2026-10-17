-- Initial schema for Rosa AI Workspace on Supabase / PostgreSQL

-- Enable UUID extension if needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Schema metadata table
CREATE TABLE IF NOT EXISTS public.schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Users table (supports Clerk user ID as primary key)
CREATE TABLE IF NOT EXISTS public.users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    auth_provider TEXT NOT NULL DEFAULT 'clerk',
    password_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OAuth identities table
CREATE TABLE IF NOT EXISTS public.oauth_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    email TEXT,
    raw_profile TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id)
);

-- Sessions table
CREATE TABLE IF NOT EXISTS public.sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    ip_hint TEXT,
    user_agent TEXT
);

-- Rate limits
CREATE TABLE IF NOT EXISTS public.rate_limits (
    bucket TEXT NOT NULL,
    subject TEXT NOT NULL,
    window_start BIGINT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, subject, window_start)
);

-- OAuth states
CREATE TABLE IF NOT EXISTS public.oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    redirect_to TEXT,
    code_verifier TEXT,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);

-- Providers configuration table
CREATE TABLE IF NOT EXISTS public.providers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    credential_mode TEXT NOT NULL,
    key_ciphertext TEXT,
    key_preview TEXT,
    organization_id TEXT,
    connection_status TEXT NOT NULL DEFAULT 'untested',
    last_connected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session-only provider keys
CREATE TABLE IF NOT EXISTS public.provider_session_keys (
    session_id TEXT NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
    api_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, provider_id)
);

-- Models table
CREATE TABLE IF NOT EXISTS public.models (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    favourite INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider_id, model_id)
);

-- Folders table
CREATE TABLE IF NOT EXISTS public.folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conversations table
CREATE TABLE IF NOT EXISTS public.conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'single',
    pane_count INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0,
    favourite INTEGER NOT NULL DEFAULT 0,
    folder_id TEXT REFERENCES public.folders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Messages table
CREATE TABLE IF NOT EXISTS public.messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    provider_id TEXT REFERENCES public.providers(id) ON DELETE SET NULL,
    model_id TEXT,
    model_name TEXT,
    metrics_json TEXT,
    status TEXT NOT NULL DEFAULT 'complete',
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_sessions_user ON public.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_providers_user ON public.providers(user_id);
CREATE INDEX IF NOT EXISTS idx_models_user ON public.models(user_id);
CREATE INDEX IF NOT EXISTS idx_models_provider ON public.models(provider_id);
CREATE INDEX IF NOT EXISTS idx_folders_user ON public.folders(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON public.conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user ON public.messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON public.rate_limits(window_start);

-- Enable Row Level Security (RLS) on user tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Helper function to extract user ID from Clerk JWT in Supabase
CREATE OR REPLACE FUNCTION public.requesting_user_id()
RETURNS TEXT AS $$
  SELECT COALESCE(
    auth.jwt() ->> 'sub',
    current_setting('request.jwt.claims', true)::json ->> 'sub'
  );
$$ LANGUAGE sql STABLE;

-- RLS Policies: users can only select and mutate their own rows
CREATE POLICY "Users can manage own record"
    ON public.users
    FOR ALL
    USING (id = public.requesting_user_id())
    WITH CHECK (id = public.requesting_user_id());

CREATE POLICY "Users can manage own providers"
    ON public.providers
    FOR ALL
    USING (user_id = public.requesting_user_id())
    WITH CHECK (user_id = public.requesting_user_id());

CREATE POLICY "Users can manage own models"
    ON public.models
    FOR ALL
    USING (user_id = public.requesting_user_id())
    WITH CHECK (user_id = public.requesting_user_id());

CREATE POLICY "Users can manage own folders"
    ON public.folders
    FOR ALL
    USING (user_id = public.requesting_user_id())
    WITH CHECK (user_id = public.requesting_user_id());

CREATE POLICY "Users can manage own conversations"
    ON public.conversations
    FOR ALL
    USING (user_id = public.requesting_user_id())
    WITH CHECK (user_id = public.requesting_user_id());

CREATE POLICY "Users can manage own messages"
    ON public.messages
    FOR ALL
    USING (user_id = public.requesting_user_id())
    WITH CHECK (user_id = public.requesting_user_id());
