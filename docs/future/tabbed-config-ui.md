# Proposed multi-Home editor

Multi-Home setups are supported through separate platform blocks and child
bridges. The current Angular settings page deliberately becomes read-only when
more than one Ambient Weather block exists; edits use Homebridge UI's JSON
Config editor. See [the Multi-Home guide](../../MultiHome.md).

## Proposed experience

Extend the existing editor with one tab per platform instance, so a user can
select a Home's settings without editing the JSON array directly. Each instance
would retain its own station filter, connection settings, sensor map, and child
bridge identity. Multiple stations within one instance would continue to share
one HomeKit Home; tabs would represent instances, not stations.

## Required design work

The present save boundary requires exactly one plugin block. A tabbed editor
cannot simply remove that guard or trust a client-supplied array index. Before
implementation, the multi-instance design must specify:

- Stable instance selection and stale-base detection across the whole file.
- Isolation of credentials, sensor drafts, previews, recovery records, and
  catalog adoption between instances.
- Verbatim preservation of unrelated platform blocks and existing `_bridge`
  settings, including when an instance is added or removed.
- Explicit consequences and recovery for removing an instance or changing a
  bridge identity, since those operations affect pairing and accessories.
- Save serialization, restart behavior, and read-only failure handling using
  supported Homebridge UI APIs.

The Angular application, DTO boundary, and build pipeline already exist. This
proposal is an extension of their single-instance contract, not a new UI stack.
No schedule or automatic bridge-generation behavior is committed. Until a
multi-instance transaction is designed and verified, JSON configuration remains
the supported workflow.
