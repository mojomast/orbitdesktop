const BRIEF_SCHEMA = {
  type: "object",
  required: [
    "schema",
    "objective",
    "project",
    "source_rev",
    "assigned_files",
    "acceptance",
    "risk"
  ],
  additionalProperties: false,
  properties: {
    schema: { const: "rizzstack.brief/1" },
    objective: { type: "string", minLength: 1, maxLength: 8000 },
    project: { type: "string", minLength: 1 },
    branch: { type: "string", minLength: 1 },
    source_rev: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
    assigned_files: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1 }
    },
    read_only: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    acceptance: {
      type: "object",
      required: ["criteria"],
      additionalProperties: false,
      properties: {
        criteria: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 }
        },
        commands: {
          type: "array",
          items: { type: "string", minLength: 1 }
        },
        tests: {
          type: "array",
          items: { type: "string", minLength: 1 }
        }
      }
    },
    tests: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    commands: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    failing_output: { type: "string", maxLength: 12000 },
    affected_tests: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    findings: {
      type: "array",
      items: { type: "string", maxLength: 4000 },
      maxItems: 20
    },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: {
        timeout_s: { type: "integer", minimum: 60, maximum: 86400 },
        max_tool_calls: { type: "integer", minimum: 1 },
        max_tokens: { type: "integer", minimum: 1 }
      }
    },
    risk: {
      type: "object",
      required: ["tier"],
      additionalProperties: false,
      properties: {
        tier: { enum: ["low", "medium", "high"] },
        reasons: { type: "array", items: { type: "string" } },
        blast_radius: { type: "string" }
      }
    },
    contract: { type: "object" },
    deps: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    wave: { type: "string" },
    retry_of: { type: "string" },
    run_id: { type: "string" },
    ticket: { type: "string" }
  },
  allOf: [
    {
      if: {
        properties: {
          risk: {
            properties: {
              tier: { const: "high" }
            }
          }
        }
      },
      then: { required: ["contract"] }
    }
  ]
};

const ATTEMPT_SCHEMA = {
  type: "object",
  required: ["schema", "attempt_id", "state", "project", "created_at", "updated_at"],
  additionalProperties: false,
  properties: {
    schema: { const: "rizzstack.attempt/1" },
    attempt_id: { type: "string", minLength: 1 },
    run_id: { type: "string" },
    retry_of: { type: "string" },
    project: { type: "string", minLength: 1 },
    branch: { type: "string" },
    model: { type: "string" },
    state: {
      enum: ["queued", "provisioning", "running", "backoff", "succeeded", "failed", "cancelled"]
    },
    reason: { type: "string" },
    created_at: { type: "string" },
    updated_at: { type: "string" },
    budget_s: { type: "integer", minimum: 1 },
    usage: {
      type: "object",
      additionalProperties: false,
      properties: {
        input_tokens: { type: ["integer", "null"], minimum: 0 },
        output_tokens: { type: ["integer", "null"], minimum: 0 },
        cost_usd: { type: ["number", "null"], minimum: 0 }
      }
    },
    result_ref: { type: "string" }
  }
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeMatches(value, declared) {
  if (declared === "object") return isObject(value);
  if (declared === "array") return Array.isArray(value);
  if (declared === "string") return typeof value === "string";
  if (declared === "integer") return typeof value === "number" && Number.isInteger(value);
  if (declared === "number") return typeof value === "number" && Number.isFinite(value);
  if (declared === "boolean") return typeof value === "boolean";
  if (declared === "null") return value === null;
  throw new Error(`unsupported JSON Schema type ${JSON.stringify(declared)}`);
}

function jsonEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every(
      key => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key])
    );
  }
  return false;
}

function check(instance, schema, path, problems) {
  if (schema === true) return;
  if (schema === false) {
    problems.push(`${path}: value is disallowed by the schema`);
    return;
  }

  if ("type" in schema) {
    const declared = schema.type;
    const names = Array.isArray(declared) ? declared : [declared];
    if (!names.some(name => typeMatches(instance, name))) {
      problems.push(`${path}: expected type ${JSON.stringify(declared)}`);
    }
  }

  if ("const" in schema && !jsonEqual(instance, schema.const)) {
    problems.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }

  if ("enum" in schema && !schema.enum.some(option => jsonEqual(instance, option))) {
    problems.push(`${path}: value ${JSON.stringify(instance)} is not in the allowed enum`);
  }

  if (typeof instance === "string") {
    const length = Array.from(instance).length;
    if ("pattern" in schema && !new RegExp(schema.pattern, "u").test(instance)) {
      problems.push(`${path}: does not match pattern ${JSON.stringify(schema.pattern)}`);
    }
    if ("minLength" in schema && length < schema.minLength) {
      problems.push(`${path}: length is below minLength ${schema.minLength}`);
    }
    if ("maxLength" in schema && length > schema.maxLength) {
      problems.push(`${path}: length exceeds maxLength ${schema.maxLength}`);
    }
  }

  if (typeof instance === "number") {
    if ("minimum" in schema && instance < schema.minimum) {
      problems.push(`${path}: value is below minimum ${schema.minimum}`);
    }
    if ("maximum" in schema && instance > schema.maximum) {
      problems.push(`${path}: value exceeds maximum ${schema.maximum}`);
    }
  }

  for (const branch of schema.allOf || []) {
    check(instance, branch, path, problems);
  }

  if ("if" in schema) {
    const conditionProblems = [];
    check(instance, schema.if, path, conditionProblems);
    if (conditionProblems.length === 0 && "then" in schema) {
      check(instance, schema.then, path, problems);
    } else if (conditionProblems.length !== 0 && "else" in schema) {
      check(instance, schema.else, path, problems);
    }
  }

  if (isObject(instance)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(instance, key)) {
        problems.push(`${path}: missing required property ${JSON.stringify(key)}`);
      }
    }

    const properties = schema.properties || {};
    for (const key of Object.keys(instance)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        check(instance[key], properties[key], `${path}.${key}`, problems);
      } else if ("additionalProperties" in schema) {
        const additional = schema.additionalProperties;
        if (additional === false) {
          problems.push(`${path}: unexpected property ${JSON.stringify(key)}`);
        } else if (isObject(additional)) {
          check(instance[key], additional, `${path}.${key}`, problems);
        }
      }
    }
  }

  if (Array.isArray(instance)) {
    if ("minItems" in schema && instance.length < schema.minItems) {
      problems.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if ("maxItems" in schema && instance.length > schema.maxItems) {
      problems.push(`${path}: more than maxItems ${schema.maxItems}`);
    }
    if ("items" in schema) {
      instance.forEach((item, index) => check(item, schema.items, `${path}[${index}]`, problems));
    }
    if (schema.uniqueItems) {
      instance.forEach((item, index) => {
        if (instance.slice(0, index).some(previous => jsonEqual(item, previous))) {
          problems.push(`${path}: duplicate item at index ${index}`);
        }
      });
    }
  }
}

function validate(document, schema) {
  const problems = [];
  check(document, schema, "$", problems);
  return problems;
}

export function validateBrief(document) {
  return validate(document, BRIEF_SCHEMA);
}

export function validateAttempt(document) {
  return validate(document, ATTEMPT_SCHEMA);
}
