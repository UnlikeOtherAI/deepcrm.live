# Phase 8 MCP smoke

- Commit SHA: 7a9d4708050284ca81e23d7c94acecf04b9f1f19
- MCP client: @modelcontextprotocol/sdk ^1.30.0; direct authenticated HTTP client
- Tenant test identifier: org_t68_4201e0a479704ac6ba276af717c2b92c / team_t68_4201e0a479704ac6ba276af717c2b92c
- Disposable database: deepcrm_t68_smoke_20260825195706 (dropped after evidence capture)
- API port: 53168
- Initial health shape: {
  "ok": "boolean",
  "version": "string",
  "db": "string"
}
- Final health shape: {
  "ok": "boolean",
  "version": "string",
  "db": "string"
}
- Audit verification: passed with node scripts/verify-audit-chain.mjs
- Cleanup: API/worker stopped; JWKS server stopped; database dropped by runner

## Required Flow Evidence

[
  {
    "item": "tools/list",
    "status": "ok",
    "count": 75
  },
  {
    "item": "resources/list",
    "status": "ok",
    "count": 5
  },
  {
    "item": "resources/read crm://templates",
    "status": "ok",
    "shape": {
      "_meta": {
        "io.modelcontextprotocol/serverInfo": {
          "name": "string",
          "version": "string"
        }
      },
      "contents": [
        {
          "uri": "string",
          "mimeType": "string",
          "text": "string"
        }
      ],
      "resultType": "string",
      "ttlMs": "number",
      "cacheScope": "string"
    }
  },
  {
    "item": "crm_template_apply",
    "status": "ok",
    "shape": {
      "added": {
        "object_types": "number",
        "attributes": "number",
        "relation_types": "number",
        "pipelines": "number",
        "matching_rules": "number"
      }
    }
  },
  {
    "item": "crm_template_apply",
    "status": "ok",
    "shape": {
      "added": {
        "object_types": "number",
        "attributes": "number",
        "relation_types": "number",
        "pipelines": "number",
        "matching_rules": "number"
      }
    }
  },
  {
    "item": "crm_template_apply",
    "status": "ok",
    "shape": {
      "added": {
        "object_types": "number",
        "attributes": "number",
        "relation_types": "number",
        "pipelines": "number",
        "matching_rules": "number"
      }
    }
  },
  {
    "item": "crm_template_apply",
    "status": "ok",
    "shape": {
      "added": {
        "object_types": "number",
        "attributes": "number",
        "relation_types": "number",
        "pipelines": "number",
        "matching_rules": "number"
      }
    }
  },
  {
    "item": "crm_template_apply",
    "status": "ok",
    "shape": {
      "added": {
        "object_types": "number",
        "attributes": "number",
        "relation_types": "number",
        "pipelines": "number",
        "matching_rules": "number"
      }
    }
  },
  {
    "item": "crm_schema_get",
    "status": "ok",
    "shape": {
      "schema_version": "number",
      "object_types": [
        {
          "id": "string",
          "slug": "string",
          "singular_name": "string",
          "plural_name": "string",
          "description": "string",
          "kind": "string",
          "primary_attribute": "string",
          "attribute_count": "number"
        }
      ],
      "relation_types": [
        {
          "id": "string",
          "slug": "string",
          "from_object_type": "string",
          "to_object_type": "null",
          "forward_name": "string",
          "inverse_name": "string",
          "description": "string",
          "cardinality": "string",
          "edge_limits": {
            "max_active_edges_from": "null",
            "max_active_edges_to": "null",
            "label_limits": {}
          },
          "on_delete": "string",
          "edge_attributes": [],
          "is_system": "boolean",
          "archived_at": "null"
        }
      ],
      "matching_rules": {
        "activity": [],
        "company": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "deal": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "invoice": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "lead": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "line_item": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "note": [],
        "order": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "payment": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "person": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "product": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "quote": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "subscription": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ],
        "task": [],
        "ticket": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "action": "string"
          }
        ]
      },
      "views": []
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "domains": [
            "string"
          ],
          "name": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "emails": [
            "string"
          ],
          "name": {
            "full": "string"
          }
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "amount": {
            "amount": "string",
            "currency": "string"
          },
          "name": "string",
          "stage": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "lifecycle_stage": "string",
          "name": "string",
          "source": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "priority": "string",
          "source_channel": "string",
          "status": "string",
          "subject": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "current_unit_price": {
            "amount": "string",
            "currency": "string"
          },
          "name": "string",
          "sku": "string",
          "status": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_pipeline_define",
    "status": "ok",
    "shape": {
      "id": "string",
      "object_type": "string",
      "slug": "string",
      "name": "string",
      "description": "string",
      "is_default": "boolean",
      "stages": [
        {
          "id": "string",
          "slug": "string",
          "name": "string",
          "position": "number",
          "probability": "null",
          "category": "string",
          "archived_at": "null"
        }
      ],
      "archived_at": "null"
    }
  },
  {
    "item": "crm_pipeline_stage_set",
    "status": "ok",
    "shape": {
      "record_id": "string",
      "pipeline": "string",
      "stage": "string",
      "changed": "boolean",
      "interval_id": "string"
    }
  },
  {
    "item": "crm_activity_log",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "direction": "string",
          "kind": "string",
          "occurred_at": "string",
          "subject": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "name": "string",
          "quote_number": "string",
          "status": "string",
          "total_amount": {
            "amount": "string",
            "currency": "string"
          }
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "billing_frequency": "string",
          "name": "string",
          "recurring_amount": {
            "amount": "string",
            "currency": "string"
          },
          "start_date": "string",
          "status": "string",
          "subscription_ref": "string",
          "support_entitlement_active": "boolean"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "name": "string",
          "order_number": "string",
          "status": "string",
          "total_amount": {
            "amount": "string",
            "currency": "string"
          }
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "balance_due": {
            "amount": "string",
            "currency": "string"
          },
          "due_date": "string",
          "invoice_number": "string",
          "issue_date": "string",
          "name": "string",
          "status": "string",
          "total_amount": {
            "amount": "string",
            "currency": "string"
          }
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "amount": {
            "amount": "string",
            "currency": "string"
          },
          "name": "string",
          "payment_ref": "string",
          "provider": "string",
          "provider_payment_ref": "string",
          "status": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "billing_frequency": "string",
          "name": "string",
          "quantity": "string",
          "sku": "string",
          "snapshot_at": "string",
          "total_amount": {
            "amount": "string",
            "currency": "string"
          },
          "unit_price": {
            "amount": "string",
            "currency": "string"
          }
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_list_create",
    "status": "ok",
    "shape": {
      "id": "string",
      "slug": "string",
      "name": "string",
      "description": "string",
      "kind": "string",
      "object_type": "string",
      "definition": {
        "list": "string",
        "object_type": "string",
        "filter": {
          "attribute": "string",
          "op": "string",
          "value": "string"
        },
        "evaluation_version": "number",
        "refresh_state": "string",
        "refresh_error_code": "null",
        "last_evaluated_at": "null"
      },
      "refresh_state": "string",
      "refresh_error_code": "null",
      "last_evaluated_at": "null",
      "attributes": [],
      "entry_count": "number"
    }
  },
  {
    "item": "crm_list_status",
    "status": "ok",
    "shape": {
      "status": {
        "list": "string",
        "object_type": "string",
        "filter": {
          "attribute": "string",
          "op": "string",
          "value": "string"
        },
        "evaluation_version": "number",
        "refresh_state": "string",
        "refresh_error_code": "null",
        "last_evaluated_at": "null"
      }
    }
  },
  {
    "item": "crm_file_register",
    "status": "ok",
    "shape": {
      "file": {
        "id": "string",
        "provider": "string",
        "provider_key": "string",
        "filename": "string",
        "mime_type": "string",
        "size_bytes": "string",
        "checksum_sha256": "string",
        "metadata": {},
        "created_at": "string"
      }
    }
  },
  {
    "item": "crm_file_link",
    "status": "ok",
    "shape": {
      "link": {
        "id": "string",
        "file_id": "string",
        "target_type": "string",
        "record_id": "string",
        "event_id": "null",
        "purpose": "string",
        "metadata": {}
      }
    }
  },
  {
    "item": "crm_file_list",
    "status": "ok",
    "shape": {
      "files": [
        {
          "file": {
            "id": "string",
            "provider": "string",
            "provider_key": "string",
            "filename": "string",
            "mime_type": "string",
            "size_bytes": "string",
            "checksum_sha256": "string",
            "metadata": {},
            "created_at": "string"
          },
          "link": {
            "id": "string",
            "file_id": "string",
            "target_type": "string",
            "record_id": "string",
            "event_id": "null",
            "purpose": "string",
            "metadata": {}
          },
          "access": {
            "url": "string",
            "expires_at": "string"
          }
        }
      ]
    }
  },
  {
    "item": "crm_event_type_define",
    "status": "ok",
    "shape": {
      "event_type": {
        "id": "string",
        "slug": "string",
        "name": "string",
        "description": "string",
        "subject_object_type": "null",
        "property_schema": {
          "type": "string",
          "properties": {
            "feature": {
              "type": "string"
            }
          },
          "additionalProperties": "boolean"
        },
        "archived_at": "null"
      }
    }
  },
  {
    "item": "crm_event_ingest",
    "status": "ok",
    "shape": {
      "event": {
        "id": "string",
        "event_type": "string",
        "source": "string",
        "external_id": "string",
        "occurred_at": "string",
        "subject_record_id": "string",
        "actor": "null",
        "properties": {
          "feature": "string"
        },
        "correction_of_event_id": "null"
      },
      "created": "boolean"
    }
  },
  {
    "item": "crm_events_query",
    "status": "ok",
    "shape": {
      "events": [
        {
          "id": "string",
          "event_type": "string",
          "source": "string",
          "external_id": "string",
          "occurred_at": "string",
          "subject_record_id": "string",
          "actor": "null",
          "properties": {
            "feature": "string"
          },
          "correction_of_event_id": "null"
        }
      ],
      "next_cursor": "null"
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "kind": "string",
          "occurred_at": "string",
          "subject": "string",
          "transcript": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_link",
    "status": "ok",
    "shape": {
      "link": {
        "id": "string",
        "relation_type": "string",
        "from_record_id": "string",
        "to_record_id": "string",
        "label": "null",
        "data": {},
        "active_from": "string",
        "active_until": "null"
      },
      "ended_links": []
    }
  },
  {
    "item": "crm_record_create",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "domains": [
            "string"
          ],
          "name": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": {
          "type": "string",
          "id": "string"
        },
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      },
      "duplicates": [
        {
          "record": {
            "id": "string",
            "object_type": "string",
            "display_name": "string"
          },
          "rule_position": "number",
          "evidence": [
            {
              "kind": "string",
              "attribute": "string",
              "matched": "boolean",
              "value": "string",
              "score": "number"
            }
          ]
        }
      ]
    }
  },
  {
    "item": "crm_record_get",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "domains": [
            "string"
          ],
          "name": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "string",
        "redacted_attributes": []
      },
      "links": {
        "payment_company": [
          {
            "link": {
              "id": "string",
              "relation_type": "string",
              "from_record_id": "string",
              "to_record_id": "string",
              "label": "null",
              "data": {},
              "active_from": "string",
              "active_until": "null"
            },
            "related": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          }
        ],
        "invoice_company": [
          {
            "link": {
              "id": "string",
              "relation_type": "string",
              "from_record_id": "string",
              "to_record_id": "string",
              "label": "null",
              "data": {},
              "active_from": "string",
              "active_until": "null"
            },
            "related": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          }
        ],
        "order_company": [
          {
            "link": {
              "id": "string",
              "relation_type": "string",
              "from_record_id": "string",
              "to_record_id": "string",
              "label": "null",
              "data": {},
              "active_from": "string",
              "active_until": "null"
            },
            "related": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          }
        ],
        "subscription_company": [
          {
            "link": {
              "id": "string",
              "relation_type": "string",
              "from_record_id": "string",
              "to_record_id": "string",
              "label": "null",
              "data": {},
              "active_from": "string",
              "active_until": "null"
            },
            "related": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          }
        ],
        "quote_company": [
          {
            "link": {
              "id": "string",
              "relation_type": "string",
              "from_record_id": "string",
              "to_record_id": "string",
              "label": "null",
              "data": {},
              "active_from": "string",
              "active_until": "null"
            },
            "related": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          }
        ],
        "activity_about": [
          {
            "link": {
              "id": "string",
              "relation_type": "string",
              "from_record_id": "string",
              "to_record_id": "string",
              "label": "null",
              "data": {},
              "active_from": "string",
              "active_until": "null"
            },
            "related": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          }
        ],
        "ticket_company": [
          {
            "link": {
              "id": "string",
              "relation_type": "string",
              "from_record_id": "string",
              "to_record_id": "string",
              "label": "null",
              "data": {},
              "active_from": "string",
              "active_until": "null"
            },
            "related": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          }
        ],
        "lead_company": [
          {
            "link": {
              "id": "string",
              "relation_type": "string",
              "from_record_id": "string",
              "to_record_id": "string",
              "label": "null",
              "data": {},
              "active_from": "string",
              "active_until": "null"
            },
            "related": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          }
        ],
        "deal_for_company": [
          {
            "link": {
              "id": "string",
              "relation_type": "string",
              "from_record_id": "string",
              "to_record_id": "string",
              "label": "null",
              "data": {},
              "active_from": "string",
              "active_until": "null"
            },
            "related": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          }
        ],
        "person_works_at": [
          {
            "link": {
              "id": "string",
              "relation_type": "string",
              "from_record_id": "string",
              "to_record_id": "string",
              "label": "null",
              "data": {},
              "active_from": "string",
              "active_until": "null"
            },
            "related": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          }
        ]
      },
      "timeline": [
        {
          "kind": "string",
          "change": {
            "id": "string",
            "seq": "string",
            "resulting_version": "number",
            "record": {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            },
            "group_id": "string",
            "kind": "string",
            "attribute": "null",
            "relation_type": "string",
            "link_id": "string",
            "actor": {
              "type": "string",
              "id": "string"
            },
            "on_behalf_of": "string",
            "provenance": {
              "run_id": "null",
              "tool_call_id": "null",
              "request_id": "string"
            },
            "reason": "string",
            "occurred_at": "string"
          },
          "occurred_at": "string"
        }
      ]
    }
  },
  {
    "item": "crm_record_get",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "amount": {
            "amount": "string",
            "currency": "string"
          },
          "line_item_count": "string",
          "line_item_total": {
            "amount": "string",
            "currency": "string"
          },
          "name": "string",
          "stage": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "string",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_get",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "current_unit_price": {
            "amount": "string",
            "currency": "string"
          },
          "line_item_count": "string",
          "line_item_revenue_total": {
            "amount": "string",
            "currency": "string"
          },
          "name": "string",
          "sku": "string",
          "status": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_history",
    "status": "ok",
    "shape": {
      "changes": [
        {
          "id": "string",
          "seq": "string",
          "resulting_version": "number",
          "record": {
            "id": "string",
            "object_type": "string",
            "display_name": "string"
          },
          "group_id": "string",
          "kind": "string",
          "attribute": "null",
          "relation_type": "string",
          "link_id": "string",
          "new_value": {
            "data": {},
            "from_record_id": "string",
            "position": "null",
            "to_record_id": "string"
          },
          "actor": {
            "type": "string",
            "id": "string"
          },
          "on_behalf_of": "string",
          "provenance": {
            "run_id": "null",
            "tool_call_id": "null",
            "request_id": "string"
          },
          "reason": "string",
          "occurred_at": "string"
        }
      ],
      "next_cursor": "null"
    }
  },
  {
    "item": "crm_record_at",
    "status": "ok",
    "shape": {
      "record_at": {
        "data": {
          "domains": [
            "string"
          ],
          "name": "string"
        },
        "links": {},
        "version_at": "number",
        "as_of": "string"
      }
    }
  },
  {
    "item": "crm_record_timeline",
    "status": "ok",
    "shape": {
      "items": [
        {
          "kind": "string",
          "record": {
            "id": "string",
            "object_type": "string",
            "display_name": "string",
            "version": "number",
            "data": {
              "kind": "string",
              "occurred_at": "string",
              "subject": "string",
              "transcript": "string"
            },
            "visibility": "string",
            "origin": "null",
            "owner": "null",
            "created_at": "string",
            "updated_at": "string",
            "last_activity_at": "null",
            "redacted_attributes": []
          },
          "about": [
            {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          ],
          "occurred_at": "string"
        }
      ],
      "next_cursor": "null"
    }
  },
  {
    "item": "crm_records_query",
    "status": "ok",
    "shape": {
      "records": [
        {
          "id": "string",
          "object_type": "string",
          "display_name": "string",
          "version": "number",
          "data": {
            "name": "string",
            "sku": "string",
            "total_amount": {
              "amount": "string",
              "currency": "string"
            }
          },
          "visibility": "string",
          "origin": "null",
          "owner": "null",
          "created_at": "string",
          "updated_at": "string",
          "last_activity_at": "null",
          "redacted_attributes": []
        }
      ],
      "next_cursor": "null"
    }
  },
  {
    "item": "crm_list_entries",
    "status": "ok",
    "shape": {
      "entries": [
        {
          "entry": {
            "id": "string",
            "data": {},
            "position": "number"
          },
          "record": {
            "id": "string",
            "object_type": "string",
            "display_name": "string",
            "version": "number",
            "data": {
              "billing_frequency": "string",
              "deal": "string",
              "invoice": "string",
              "name": "string",
              "order": "string",
              "product": "string",
              "quantity": "string",
              "quote": "string",
              "sku": "string",
              "snapshot_at": "string",
              "subscription": "string",
              "total_amount": {
                "amount": "string",
                "currency": "string"
              },
              "unit_price": {
                "amount": "string",
                "currency": "string"
              }
            },
            "visibility": "string",
            "origin": "null",
            "owner": "null",
            "created_at": "string",
            "updated_at": "string",
            "last_activity_at": "null",
            "redacted_attributes": []
          }
        }
      ],
      "next_cursor": "null",
      "list": {
        "kind": "string",
        "refresh_state": "string",
        "evaluation_version": "number"
      }
    }
  },
  {
    "item": "crm_record_get",
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "amount": {
            "amount": "string",
            "currency": "string"
          },
          "line_item_count": "string",
          "line_item_total": {
            "amount": "string",
            "currency": "string"
          },
          "name": "string",
          "stage": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "string",
        "redacted_attributes": []
      }
    }
  },
  {
    "item": "crm_record_update",
    "status": "expected_error",
    "shape": {
      "attribute": "string",
      "code": "string",
      "message": "string",
      "next": "string"
    }
  },
  {
    "item": "member tools/list",
    "status": "ok",
    "count": 75
  },
  {
    "item": "crm_record_get",
    "status": "expected_error",
    "shape": {
      "code": "string",
      "message": "string",
      "next": "string"
    }
  },
  {
    "item": "crm_records_query",
    "status": "ok",
    "shape": {
      "records": [],
      "next_cursor": "null",
      "total": "number"
    }
  },
  {
    "item": "member private discovery query",
    "status": "ok",
    "shape": {
      "records": [],
      "next_cursor": "null",
      "total": "number"
    }
  },
  {
    "item": "crm_record_timeline",
    "status": "ok",
    "shape": {
      "items": [
        {
          "kind": "string",
          "record": {
            "id": "string",
            "object_type": "string",
            "display_name": "string",
            "version": "number",
            "data": {
              "kind": "string",
              "occurred_at": "string",
              "subject": "string"
            },
            "visibility": "string",
            "origin": "null",
            "owner": "null",
            "created_at": "string",
            "updated_at": "string",
            "last_activity_at": "null",
            "redacted_attributes": [
              "string"
            ]
          },
          "about": [
            {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          ],
          "occurred_at": "string"
        }
      ],
      "next_cursor": "null"
    }
  },
  {
    "item": "member restricted redaction check",
    "status": "ok",
    "shape": {
      "transcript_present": false,
      "redacted_attributes_contains_transcript": true
    }
  }
]

## Worker Jobs

[
  {
    "_count": {
      "_all": 17
    },
    "type": "derived.refresh",
    "status": "completed"
  },
  {
    "_count": {
      "_all": 3
    },
    "type": "list.refresh",
    "status": "completed"
  },
  {
    "_count": {
      "_all": 71
    },
    "type": "record.reindex",
    "status": "completed"
  }
]

## Data Handling

Only tool/resource names, redacted result shapes, counts, booleans and test identifiers are recorded. Credentials, bearer tokens, signed URLs, webhook secrets, raw CRM values, raw event payloads and raw file payloads are omitted.
