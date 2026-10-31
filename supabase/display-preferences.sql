-- REVIEW CANDIDATE ONLY. Not applied by the author; not a timestamp migration.
-- The main operator must inspect object-name collisions and run database/RLS
-- integration checks separately before applying through the approved workflow.
-- Own-row policy reference:
-- https://supabase.com/docs/guides/database/postgres/row-level-security
-- No extensions, existing application tables, or authentication objects changed.
-- All CREATEs intentionally fail on collisions; the transaction is all-or-nothing.
BEGIN;

CREATE FUNCTION public.user_ui_preferences_exact_keys(p_value jsonb, p_keys text[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF pg_catalog.jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR p_keys IS NULL THEN
    RETURN false;
  END IF;
  RETURN p_value ?& p_keys
    AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_value))
      = pg_catalog.cardinality(p_keys);
END;
$function$;

CREATE FUNCTION public.user_ui_preferences_bounded_integer(p_value jsonb, p_min integer, p_max integer)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_number numeric;
BEGIN
  IF pg_catalog.jsonb_typeof(p_value) IS DISTINCT FROM 'number'
    OR p_min IS NULL OR p_max IS NULL OR p_min > p_max THEN
    RETURN false;
  END IF;
  -- Only cast after the JSON type guard, never cast strings or JSON/SQL nulls.
  v_number := (p_value #>> '{}')::numeric;
  RETURN v_number BETWEEN p_min AND p_max AND pg_catalog.trunc(v_number) = v_number;
END;
$function$;

CREATE FUNCTION public.user_ui_preferences_valid(p_preferences jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  device_ids CONSTANT text[] := ARRAY['desktop', 'tablet', 'mobile'];
  module_ids CONSTANT text[] := ARRAY[
    'free', 'income', 'expense', 'net-worth', 'budget', 'accounts', 'sgd-myr',
    'usd-sgd', 'currency', 'recent', 'watchlist', 'reminders', 'quick'
  ];
  sidebar_ids CONSTANT text[] := ARRAY[
    'home', 'accounts', 'reports', 'transactions', 'budget', 'assets', 'goals',
    'cashflow', 'watchlists', 'insurance', 'insights', 'fx', 'trash', 'settings',
    'capture', 'transfer', 'obsidian', 'excel', 'theme-mode', 'appearance'
  ];
  locked_sidebar_ids CONSTANT text[] := ARRAY['home', 'settings'];
  motion_presets CONSTANT text[] := ARRAY[
    'none', 'fade', 'up', 'down', 'left', 'right', 'spring', 'zoom', 'reveal'
  ];
  group_motions CONSTANT text[] := ARRAY['none', 'stagger'];
  width_choices CONSTANT integer[] := ARRAY[4, 6, 8, 12];
  weight_choices CONSTANT integer[] := ARRAY[400, 600, 700];
  weight_fields CONSTANT text[] := ARRAY['titleWeight', 'amountWeight', 'bodyWeight'];
  boolean_fields CONSTANT text[] := ARRAY['visible', 'detailsExpanded'];
  v_device text;
  v_field text;
  v_id text;
  v_layout jsonb;
  v_item jsonb;
  v_hidden jsonb;
  v_entry jsonb;
  v_seen text[];
  v_rule record;
BEGIN
  -- Do not use STRICT: SQL NULL must return false, not a CHECK-passing NULL.
  IF NOT public.user_ui_preferences_exact_keys(p_preferences, ARRAY['version', 'sidebar', 'devices']) THEN
    RETURN false;
  END IF;
  IF NOT public.user_ui_preferences_bounded_integer(p_preferences -> 'version', 1, 1) THEN
    RETURN false;
  END IF;
  IF NOT public.user_ui_preferences_exact_keys(p_preferences -> 'sidebar', ARRAY['hidden']) THEN
    RETURN false;
  END IF;
  v_hidden := p_preferences -> 'sidebar' -> 'hidden';
  IF pg_catalog.jsonb_typeof(v_hidden) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_array_length(v_hidden)
    > pg_catalog.cardinality(sidebar_ids) - pg_catalog.cardinality(locked_sidebar_ids) THEN
    RETURN false;
  END IF;
  v_seen := ARRAY[]::text[];
  FOR v_entry IN SELECT value FROM pg_catalog.jsonb_array_elements(v_hidden) LOOP
    IF pg_catalog.jsonb_typeof(v_entry) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    v_id := v_entry #>> '{}';
    IF NOT (v_id = ANY(sidebar_ids)) OR v_id = ANY(locked_sidebar_ids) OR v_id = ANY(v_seen) THEN
      RETURN false;
    END IF;
    v_seen := pg_catalog.array_append(v_seen, v_id);
  END LOOP;

  IF NOT public.user_ui_preferences_exact_keys(p_preferences -> 'devices', ARRAY['desktop', 'tablet', 'mobile']) THEN
    RETURN false;
  END IF;
  FOREACH v_device IN ARRAY device_ids LOOP
    v_layout := p_preferences -> 'devices' -> v_device;
    IF NOT public.user_ui_preferences_exact_keys(v_layout, ARRAY['enabled', 'gap', 'groupMotion', 'items']) THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(v_layout -> 'enabled') IS DISTINCT FROM 'boolean' THEN
      RETURN false;
    END IF;
    IF NOT public.user_ui_preferences_bounded_integer(v_layout -> 'gap', 12, 32) THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(v_layout -> 'groupMotion') IS DISTINCT FROM 'string'
      OR NOT (v_layout ->> 'groupMotion' = ANY(group_motions)) THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(v_layout -> 'items') IS DISTINCT FROM 'array' THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_array_length(v_layout -> 'items') <> pg_catalog.cardinality(module_ids) THEN
      RETURN false;
    END IF;
    v_seen := ARRAY[]::text[];
    FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(v_layout -> 'items') LOOP
      IF NOT public.user_ui_preferences_exact_keys(v_item, ARRAY[
        'id', 'width', 'height', 'padding', 'title', 'amount', 'body', 'titleWeight',
        'amountWeight', 'bodyWeight', 'motion', 'duration', 'visible', 'detailsExpanded'
      ]) THEN
        RETURN false;
      END IF;
      IF pg_catalog.jsonb_typeof(v_item -> 'id') IS DISTINCT FROM 'string' THEN
        RETURN false;
      END IF;
      v_id := v_item ->> 'id';
      IF NOT (v_id = ANY(module_ids)) OR v_id = ANY(v_seen) THEN
        RETURN false;
      END IF;
      v_seen := pg_catalog.array_append(v_seen, v_id);
      FOR v_rule IN SELECT * FROM (VALUES
        ('width', 4, 12), ('height', 144, 400), ('padding', 14, 32),
        ('title', 13, 28), ('amount', 20, 64), ('body', 13, 18), ('duration', 120, 600)
      ) AS numeric_rules(field, lower_bound, upper_bound) LOOP
        IF NOT public.user_ui_preferences_bounded_integer(v_item -> v_rule.field, v_rule.lower_bound, v_rule.upper_bound) THEN
          RETURN false;
        END IF;
      END LOOP;
      -- These casts follow the numeric guards, so numeric strings cannot pass.
      IF NOT ((v_item ->> 'width')::numeric = ANY(width_choices)) THEN
        RETURN false;
      END IF;
      FOREACH v_field IN ARRAY weight_fields LOOP
        IF NOT public.user_ui_preferences_bounded_integer(v_item -> v_field, 400, 700) THEN
          RETURN false;
        END IF;
        IF NOT ((v_item ->> v_field)::numeric = ANY(weight_choices)) THEN
          RETURN false;
        END IF;
      END LOOP;
      FOREACH v_field IN ARRAY boolean_fields LOOP
        IF pg_catalog.jsonb_typeof(v_item -> v_field) IS DISTINCT FROM 'boolean' THEN
          RETURN false;
        END IF;
      END LOOP;
      IF pg_catalog.jsonb_typeof(v_item -> 'motion') IS DISTINCT FROM 'string'
        OR NOT (v_item ->> 'motion' = ANY(motion_presets)) THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END;
$function$;

CREATE TABLE public.user_ui_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  preferences jsonb NOT NULL CHECK (public.user_ui_preferences_valid(preferences) IS TRUE),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE FUNCTION public.user_ui_preferences_stamp()
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
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UI preferences owner cannot change';
    END IF;
    IF OLD.revision >= 2147483647 THEN
      RAISE EXCEPTION USING ERRCODE = '22003', MESSAGE = 'UI preferences revision exhausted';
    END IF;
    NEW.revision := OLD.revision + 1;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Unsupported UI preferences operation';
  END IF;
  NEW.schema_version := 1;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER user_ui_preferences_stamp_before_write
BEFORE INSERT OR UPDATE ON public.user_ui_preferences
FOR EACH ROW EXECUTE FUNCTION public.user_ui_preferences_stamp();

ALTER TABLE public.user_ui_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_ui_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY user_ui_preferences_select_own ON public.user_ui_preferences
FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY user_ui_preferences_insert_own ON public.user_ui_preferences
FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY user_ui_preferences_update_own ON public.user_ui_preferences
FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

REVOKE ALL ON TABLE public.user_ui_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_ui_preferences TO authenticated;
GRANT INSERT (user_id, preferences) ON TABLE public.user_ui_preferences TO authenticated;
GRANT UPDATE (preferences) ON TABLE public.user_ui_preferences TO authenticated;

-- Validation executes as the writer during CHECK evaluation. No anonymous RPCs.
REVOKE ALL ON FUNCTION public.user_ui_preferences_exact_keys(jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.user_ui_preferences_bounded_integer(jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.user_ui_preferences_valid(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.user_ui_preferences_stamp() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_ui_preferences_exact_keys(jsonb, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_ui_preferences_bounded_integer(jsonb, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_ui_preferences_valid(jsonb) TO authenticated;
-- The trigger is installed by the owner; no client EXECUTE grant is necessary
-- for its subsequent firing. Its body still runs with invoker privileges.

-- Client protocol: INSERT only (user_id, preferences); PATCH only preferences,
-- filtered by user_id AND the last observed revision, returning revision/preferences.
-- No client-controlled timestamps/revisions, overwrite-upsert, or delete path.
COMMIT;
