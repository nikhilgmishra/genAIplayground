-- Approved knowledge corpus (spec section 9): controlled ingestion, exact
-- versions, permission-filtered retrieval. Knowledge items are approved
-- administrative articles/runbooks; customer transcripts are NEVER stored or
-- indexed here (no shared embedding index of customer content).
--
-- Roles:
--   app_worker  ingestion pipeline: reads, inserts and updates status fields.
--   app_runtime retrieval only: SELECT restricted by RLS to SERVABLE rows
--               (approved, not quarantined, not held for review, not superseded).
--   app_console / app_auditor read every row of the tenant (review queue, audit).
-- Nobody but the owner can delete; content of a stored version is immutable
-- (trigger), so a citation "kb_<sourceId>@v<version>" always names one text (OPS-06).

create table knowledge_items (
  tenant_id              text        not null check (char_length(tenant_id) between 3 and 80),
  source_id              text        not null check (source_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$'),
  version                integer     not null check (version between 1 and 1000000),
  source_system          text        not null check (source_system in ('salesforce_knowledge', 'approved_runbook')),
  title                  text        not null check (char_length(title) between 1 and 200),
  body_sanitized         text        not null check (char_length(body_sanitized) between 1 and 20000),
  owner                  text        not null check (char_length(owner) between 3 and 80),
  audiences              text[]      not null check (cardinality(audiences) between 1 and 8),
  permitted_intents      text[]      not null check (cardinality(permitted_intents) between 1 and 16),
  jurisdiction           text        not null check (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  language               text        not null check (language ~ '^[a-z]{2,3}(-[a-z]{2})?$'),
  effective_from         timestamptz not null,
  expires_at             timestamptz,
  sensitivity            text        not null check (sensitivity in ('PUBLIC', 'INTERNAL')),
  approval_status        text        not null check (approval_status in ('APPROVED', 'PENDING', 'REJECTED')),
  approved_by            text,
  approved_at            timestamptz,
  -- sha256 over the sanitized title + body (conflict detection: same content = no conflict).
  content_digest         text        not null check (content_digest ~ '^[a-f0-9]{64}$'),
  -- sha256 over every field except approval (version immutability).
  item_digest            text        not null check (item_digest ~ '^[a-f0-9]{64}$'),
  quarantined            boolean     not null default false,
  quarantine_reasons     text[]      not null default '{}',
  held_for_review        boolean     not null default false,
  review_reasons         text[]      not null default '{}',
  superseded_by_version  integer,
  ingested_at            timestamptz not null,
  status_changed_at      timestamptz not null,
  servable boolean generated always as (
    approval_status = 'APPROVED' and not quarantined and not held_for_review and superseded_by_version is null
  ) stored,
  tsv tsvector generated always as (
    case split_part(language, '-', 1)
      when 'en' then setweight(to_tsvector('english'::regconfig, title), 'A') || setweight(to_tsvector('english'::regconfig, body_sanitized), 'B')
      when 'es' then setweight(to_tsvector('spanish'::regconfig, title), 'A') || setweight(to_tsvector('spanish'::regconfig, body_sanitized), 'B')
      else setweight(to_tsvector('simple'::regconfig, title), 'A') || setweight(to_tsvector('simple'::regconfig, body_sanitized), 'B')
    end
  ) stored,
  primary key (tenant_id, source_id, version),
  constraint knowledge_items_window check (expires_at is null or expires_at > effective_from),
  constraint knowledge_items_approval_shape check (approval_status <> 'APPROVED' or (approved_by is not null and approved_at is not null)),
  constraint knowledge_items_public_audience check (not ('public' = any (audiences)) or sensitivity = 'PUBLIC'),
  constraint knowledge_items_quarantine_reasons check (quarantined = (cardinality(quarantine_reasons) > 0)),
  constraint knowledge_items_review_reasons check (held_for_review = (cardinality(review_reasons) > 0)),
  -- A row that is not approved can only exist as a quarantined review record.
  constraint knowledge_items_unapproved_quarantined check (approval_status = 'APPROVED' or quarantined),
  constraint knowledge_items_superseded check (superseded_by_version is null or superseded_by_version > version)
);

create index knowledge_items_servable on knowledge_items (tenant_id, language, jurisdiction) where servable;
create index knowledge_items_tsv on knowledge_items using gin (tsv);
create index knowledge_items_intents on knowledge_items using gin (permitted_intents);
create index knowledge_items_audiences on knowledge_items using gin (audiences);

-- Content of a stored version never changes; only status fields may.
create or replace function knowledge_items_immutable_content() returns trigger language plpgsql as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.source_id is distinct from old.source_id
     or new.version is distinct from old.version
     or new.source_system is distinct from old.source_system
     or new.title is distinct from old.title
     or new.body_sanitized is distinct from old.body_sanitized
     or new.owner is distinct from old.owner
     or new.audiences is distinct from old.audiences
     or new.permitted_intents is distinct from old.permitted_intents
     or new.jurisdiction is distinct from old.jurisdiction
     or new.language is distinct from old.language
     or new.effective_from is distinct from old.effective_from
     or new.expires_at is distinct from old.expires_at
     or new.sensitivity is distinct from old.sensitivity
     or new.content_digest is distinct from old.content_digest
     or new.item_digest is distinct from old.item_digest
     or new.ingested_at is distinct from old.ingested_at then
    raise exception 'KNOWLEDGE_VERSION_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger knowledge_items_immutable
  before update on knowledge_items
  for each row execute function knowledge_items_immutable_content();

-- Pinned corpus snapshots (OPS-06). Metadata only (ids, versions, digests).
create table knowledge_snapshots (
  tenant_id         text        not null,
  snapshot_seq      integer     not null check (snapshot_seq >= 1),
  snapshot_version  text        not null check (snapshot_version ~ '^kb\.[0-9]{1,9}\.[a-f0-9]{12}$'),
  snapshot_digest   text        not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  item_count        integer     not null check (item_count >= 0),
  items             jsonb       not null,
  created_at        timestamptz not null,
  primary key (tenant_id, snapshot_seq),
  unique (tenant_id, snapshot_version)
);

create or replace function knowledge_snapshots_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'KNOWLEDGE_SNAPSHOTS_APPEND_ONLY' using errcode = '42501';
end
$$;

create trigger knowledge_snapshots_no_update_delete
  before update or delete on knowledge_snapshots
  for each row execute function knowledge_snapshots_append_only();
create trigger knowledge_snapshots_no_truncate
  before truncate on knowledge_snapshots
  for each statement execute function knowledge_snapshots_append_only();

alter table knowledge_items enable row level security;
alter table knowledge_items force row level security;
alter table knowledge_snapshots enable row level security;
alter table knowledge_snapshots force row level security;

create policy knowledge_items_runtime_read on knowledge_items for select
  to app_runtime using (tenant_id = app_tenant() and servable);
create policy knowledge_items_review_read on knowledge_items for select
  to app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy knowledge_items_worker_insert on knowledge_items for insert
  to app_worker with check (tenant_id = app_tenant());
create policy knowledge_items_worker_update on knowledge_items for update
  to app_worker using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

create policy knowledge_snapshots_read on knowledge_snapshots for select
  to app_runtime, app_worker, app_console, app_auditor using (tenant_id = app_tenant());
create policy knowledge_snapshots_insert on knowledge_snapshots for insert
  to app_worker with check (tenant_id = app_tenant());

revoke all on knowledge_items, knowledge_snapshots from public;
grant select on knowledge_items to app_runtime, app_console, app_auditor;
grant select, insert, update on knowledge_items to app_worker;
grant select on knowledge_snapshots to app_runtime, app_console, app_auditor;
grant select, insert on knowledge_snapshots to app_worker;

-- Optional pgvector embeddings over the APPROVED corpus only. Created only when
-- the extension is available and can be created; plain PostgreSQL without
-- pgvector still migrates and retrieval falls back to full text search.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    begin
      create extension if not exists vector;
    exception when insufficient_privilege or feature_not_supported or undefined_file then
      raise notice 'KNOWLEDGE_VECTOR_EXTENSION_UNAVAILABLE';
    end;
  end if;
  if exists (select 1 from pg_extension where extname = 'vector') then
    execute $ddl$
      create table knowledge_embeddings (
        tenant_id        text        not null,
        source_id        text        not null,
        version          integer     not null,
        embedding_model  text        not null check (embedding_model ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
        embedding        vector(256) not null,
        created_at       timestamptz not null,
        primary key (tenant_id, source_id, version, embedding_model),
        foreign key (tenant_id, source_id, version) references knowledge_items (tenant_id, source_id, version) on delete cascade
      )
    $ddl$;
    execute 'alter table knowledge_embeddings enable row level security';
    execute 'alter table knowledge_embeddings force row level security';
    execute 'create policy knowledge_embeddings_read on knowledge_embeddings for select to app_runtime, app_worker, app_console, app_auditor using (tenant_id = app_tenant())';
    execute 'create policy knowledge_embeddings_insert on knowledge_embeddings for insert to app_worker with check (tenant_id = app_tenant())';
    execute 'create policy knowledge_embeddings_delete on knowledge_embeddings for delete to app_worker using (tenant_id = app_tenant())';
    execute 'revoke all on knowledge_embeddings from public';
    execute 'grant select on knowledge_embeddings to app_runtime, app_console, app_auditor';
    execute 'grant select, insert, delete on knowledge_embeddings to app_worker';
  end if;
end
$$;
