-- The contact-point policy resource (schema-engine §4d‴, auth-and-tenancy §4). crm_contact_point_set — reach,
-- unreach, confirm, replace_others and restore on a record's emails and phones — is decided by `contact_point.edit`
-- instead of `attribute.edit`, so a team member may archive and restore a confidential phone without being able to
-- edit confidential attributes in general. Alone in its migration: an enum value cannot be used in the transaction
-- that adds it, and 20261019150100_contact_point_policy_rules inserts the rules that use it.
ALTER TYPE "PolicyResourceType" ADD VALUE 'contact_point';
