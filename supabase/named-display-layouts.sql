-- REVIEW CANDIDATE ONLY. No deployment, seeds, or existing-object changes.
-- Manual audit prerequisite: main must compare the deployed definitions/ACLs of
-- public.user_ui_preferences_exact_keys(jsonb, text[]) and
-- public.user_ui_preferences_valid(jsonb) with display-preferences.sql, including
-- authenticated EXECUTE on their dependencies, INVOKER, and pg_catalog path.
-- Those existing validators are deliberately not created, replaced, or granted here.
-- PostgreSQL 17 / UTF8 required; normalize(value, NFKC) uses parser-special syntax.
-- All CREATEs fail on collisions; the entire candidate is atomic. Main may strip
-- only the outer BEGIN/COMMIT for an explicitly authorized migration workflow.
-- RLS reference: https://supabase.com/docs/guides/database/postgres/row-level-security
BEGIN;

CREATE FUNCTION public.user_ui_layout_libraries_valid(p_library jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  -- Explicit Cc/Cf/Zl/Zp ranges, not locale-dependent POSIX character classes.
  -- JSONB in UTF8 rejects U+0000 and unpaired Cs surrogates before this function.
  -- Keep this set aligned with the client's Unicode property regex on upgrades.
  unsafe_name_pattern CONSTANT text := U&'[\0001-\001F\007F-\009F\00AD\0600-\0605\061C\06DD\070F\0890-\0891\08E2\180E\200B-\200F\2028-\202E\2060-\2064\2066-\206F\FEFF\FFF9-\FFFB\+0110BD\+0110CD\+013430-\+01343F\+01BCA0-\+01BCA3\+01D173-\+01D17A\+0E0001\+0E0020-\+0E007F]';
  -- ECMAScript trim whitespace that is NOT already forbidden above. NFKC maps
  -- most of these to ASCII space, but U+1680 survives and must be explicit.
  -- Tabs/newlines, U+2028/U+2029 and U+FEFF are rejected BEFORE normalization.
  trim_name_characters CONSTANT text := U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000';
  v_scheme jsonb;
  v_id text;
  v_name text;
  v_normalized_name text;
  v_name_key text;
  v_seen_ids text[] := ARRAY[]::text[];
  v_seen_names text[] := ARRAY[]::text[];
BEGIN
  -- Not STRICT: SQL NULL must produce false, not a CHECK-passing NULL.
  IF public.user_ui_preferences_exact_keys(p_library, ARRAY['version', 'schemes']) IS NOT TRUE THEN
    RETURN false;
  END IF;
  IF p_library -> 'version' IS DISTINCT FROM '1'::jsonb THEN
    RETURN false;
  END IF;
  -- Bound the stored JSONB text in UTF8 bytes, not characters or heap size.
  -- This is intentionally conservative versus compact JSON wire bytes. The
  -- client's 256 KiB LOCAL envelope also contains base + library, not just this row.
  IF pg_catalog.octet_length(p_library::text) > 262144 THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_typeof(p_library -> 'schemes') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_array_length(p_library -> 'schemes') > 10 THEN
    RETURN false;
  END IF;

  FOR v_scheme IN SELECT value FROM pg_catalog.jsonb_array_elements(p_library -> 'schemes') LOOP
    IF public.user_ui_preferences_exact_keys(v_scheme, ARRAY['id', 'name', 'preferences']) IS NOT TRUE THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(v_scheme -> 'id') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_scheme -> 'name') IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    v_id := v_scheme ->> 'id';
    IF pg_catalog.char_length(v_id) <> 36
      OR v_id COLLATE pg_catalog."C" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR v_id COLLATE pg_catalog."C" = ANY(v_seen_ids) THEN
      RETURN false;
    END IF;
    v_name := v_scheme ->> 'name';
    IF v_name COLLATE pg_catalog."C" ~ unsafe_name_pattern THEN
      RETURN false;
    END IF;
    v_normalized_name := pg_catalog.btrim(normalize(v_name, NFKC), trim_name_characters);
    -- Require canonical storage; never silently rewrite remote names.
    IF v_name COLLATE pg_catalog."C" IS DISTINCT FROM v_normalized_name COLLATE pg_catalog."C"
      OR pg_catalog.char_length(v_normalized_name) NOT BETWEEN 1 AND 30
      OR v_normalized_name COLLATE pg_catalog."C" ~ unsafe_name_pattern THEN
      RETURN false;
    END IF;
    -- ASCII-only folding; C collation also makes array equality deterministic.
    v_name_key := pg_catalog.translate(v_name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
    IF v_name_key COLLATE pg_catalog."C" = ANY(v_seen_names) THEN
      RETURN false;
    END IF;
    IF public.user_ui_preferences_valid(v_scheme -> 'preferences') IS NOT TRUE THEN
      RETURN false;
    END IF;
    v_seen_ids := pg_catalog.array_append(v_seen_ids, v_id);
    v_seen_names := pg_catalog.array_append(v_seen_names, v_name_key);
  END LOOP;
  RETURN true;
END;
$function$;

CREATE TABLE public.user_ui_layout_libraries (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  library jsonb NOT NULL CHECK (public.user_ui_layout_libraries_valid(library) IS TRUE),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE FUNCTION public.user_ui_layout_libraries_stamp()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.revision := 1;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UI layout library owner cannot change';
    END IF;
    IF OLD.revision >= 2147483647 THEN
      RAISE EXCEPTION USING ERRCODE = '22003', MESSAGE = 'UI layout library revision exhausted';
    END IF;
    NEW.revision := OLD.revision + 1;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Unsupported UI layout library operation';
  END IF;
  NEW.schema_version := 1;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER user_ui_layout_libraries_stamp_before_write
BEFORE INSERT OR UPDATE ON public.user_ui_layout_libraries
FOR EACH ROW EXECUTE FUNCTION public.user_ui_layout_libraries_stamp();

ALTER TABLE public.user_ui_layout_libraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_ui_layout_libraries FORCE ROW LEVEL SECURITY;

CREATE POLICY user_ui_layout_libraries_select_own ON public.user_ui_layout_libraries
FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY user_ui_layout_libraries_insert_own ON public.user_ui_layout_libraries
FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY user_ui_layout_libraries_update_own ON public.user_ui_layout_libraries
FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

REVOKE ALL ON TABLE public.user_ui_layout_libraries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_ui_layout_libraries TO authenticated;
GRANT INSERT (user_id, library) ON TABLE public.user_ui_layout_libraries TO authenticated;
GRANT UPDATE (library) ON TABLE public.user_ui_layout_libraries TO authenticated;

REVOKE ALL ON FUNCTION public.user_ui_layout_libraries_valid(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.user_ui_layout_libraries_stamp() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_ui_layout_libraries_valid(jsonb) TO authenticated;
-- Trigger execution does not require granting client EXECUTE on the trigger helper.

-- Independent of active display preferences: no old-client writes or mirroring.
-- Client INSERT sends only user_id/library; PATCH sends only library, filtered
-- by own user_id AND last observed revision. Zero-row PATCH is a conflict, not an
-- invitation to overwrite/upsert. No client DELETE; empty schemes clears the list.
-- The sole ON DELETE CASCADE follows deletion of that same auth account.
COMMIT;
