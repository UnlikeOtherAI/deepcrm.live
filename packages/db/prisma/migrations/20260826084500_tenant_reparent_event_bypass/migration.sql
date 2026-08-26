CREATE OR REPLACE FUNCTION prevent_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('deepcrm.tenant_reparent', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'events are immutable; write a correction event instead';
END;
$$;
