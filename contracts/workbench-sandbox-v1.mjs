// Independent provider contract; no workspace/layout schema change.
export const SANDBOX_KIND='gvisor';
export const SANDBOX_SPEC_VERSION=1;
export const SANDBOX_POLICY=Object.freeze({platform:'systrap',rootless:true,network:'none',root_readonly:true,source_readonly:true,guest_node:'/usr/local/bin/node',guest_runner:'/opt/orbit/runner.mjs',guest_source:'/workspace',storage:'No disk quota; writable guest tmpfs is not advertised as a storage quota.'});
export const SANDBOX_REASONS=Object.freeze(['disabled','not_probed','configuration_invalid','runsc_missing','runsc_hash_mismatch','runtime_layout_unsupported','runtime_payload_unverified','runtime_payload_changed','rootfs_missing','rootfs_hash_mismatch','permissions_invalid','platform_unsupported','network_policy_invalid','disk_quota_unsupported','user_namespace_unavailable','runtime_probe_failed','resources_unknown']);
