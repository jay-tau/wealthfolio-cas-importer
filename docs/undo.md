# Undo of an import

This is the contract for **Undo this import** (detailed statements) and **Undo this update**
(holdings statements) on the import flow's Done screen. Phase 3 of the import redesign builds it and
links here. Any later change to Undo updates this document first.

Undo is bounded. It's offered only while what the import saved is unchanged. When something has
changed, it refuses and says why, changing nothing. It also says what it can't take back. It's
built only on what Wealthfolio's add-on SDK 3.13.0 allows. Links to Wealthfolio's code point at the
`v3.13.0` tag; links to the add-on's code point at the commit this document was written on.

## What an import changes

A detailed import:

- adds activities with `activities.import`
  ([`import-page.tsx` L384](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/pages/import-page.tsx#L384)).
  They carry the import's `importRunId` when Wealthfolio saved its import-run record
  ([`activities_service.rs` L8769-L8785](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/activities/activities_service.rs#L8769-L8785)).
- for each bank entry the user chose to reuse, adds the fund account's transfer with
  `activities.create`. If the entry is a withdrawal or deposit, it changes the entry into a transfer
  with `activities.update`. It then links the two with `activities.linkTransfer`
  ([`linkBankRow`, `plan.ts` L566-L611](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/cas/plan.ts#L566-L611)).
  A reused entry is a withdrawal, a deposit or a transfer that isn't linked yet
  ([`plan.ts` L521-L522](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/cas/plan.ts#L521-L522),
  [L542-L546](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/cas/plan.ts#L542-L546)).
- for a fund priced by hand, saves each trade's NAV as that day's price
  ([`activities_service.rs` L9659-L9688](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/activities/activities_service.rs#L9659-L9688)).
  A manual quote is keyed by its asset and day, so this replaces a price the user set by hand on that
  day ([`quotes/service.rs` L1565-L1582](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/quotes/service.rs#L1565-L1582)).
- can create assets.

A holdings import:

- saves one snapshot per account with `snapshots.save`
  ([`holdings-import.tsx` L546](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/pages/holdings-import.tsx#L546)).
  It replaces a snapshot already saved for that date only if the user agreed.
- writes statement prices, and the last price of kept holdings, with `quotes.update`
  ([L221-L240](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/pages/holdings-import.tsx#L221-L240)).
- keeps printed details on assets with `assets.updateProfile`
  ([L241-L264](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/pages/holdings-import.tsx#L241-L264)).
- updates the add-on's own records in storage: imports, unlisted sources and the source index
  ([L557-L570](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/pages/holdings-import.tsx#L557-L570);
  [`saveImports`, `indexSources`, `saveUnlisted` in `choices.ts`](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/lib/choices.ts#L187-L301)).
- can create assets. Saving a snapshot gives a holding priced by hand its average cost as a price,
  but only when the asset has no price on or before that date
  ([`manual_snapshot_service.rs` L318-L337](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/portfolio/snapshot/manual_snapshot_service.rs#L318-L337)).

Either kind can also create accounts with `accounts.create`, through Phase 2's account proposal.

## What the SDK can and can't reverse

SDK 3.13.0 can:

- delete activities, with `activities.saveMany`
  ([`host-api.ts` L194-L199](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L194-L199)).
- unlink a transfer pair, with `activities.unlinkTransfer`
  ([L275](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L275)).
- delete an account's snapshot on a date, with `snapshots.delete`
  ([L1043](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L1043)).
- write quotes, asset profiles and the add-on's storage, as the import does.

It can't:

- delete accounts, assets or quotes. `accounts` has only `getAll` and `create`, `assets` has no
  delete, and `quotes` has only `update` and `getHistory`
  ([L79-L92](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L79-L92),
  [L345-L367](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L345-L367),
  [L414-L429](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L414-L429)).
- write spending splits. It can read them, through the Spending API
  ([L512-L554](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L512-L554)).
- set `isUserModified` back to false. `ActivityUpdate` has no such field
  ([`data-types.ts` L321-L343](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/data-types.ts#L321-L343)).

Activities carry `updatedAt`, `importRunId` and `isUserModified`
([`data-types.ts` L240-L273](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/data-types.ts#L240-L273)).
A snapshot's info has an ID, a date, a source and counts, but no time it was changed
([L1445-L1451](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/data-types.ts#L1445-L1451)).
The saved snapshot's ID is a stable UUID derived from its account and date
([`snapshot_service.rs` L766-L780](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/portfolio/snapshot/snapshot_service.rs#L766-L780),
[`snapshot_model.rs` L186-L211](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/portfolio/snapshot/snapshot_model.rs#L186-L211)),
so it stays the same when the snapshot is saved again on that date. Only a snapshot's contents show
whether it changed.

Wealthfolio deletes a linked transfer pair whole, both through a single delete and through
`saveMany`
([`activities_service.rs` L7205-L7216](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/activities/activities_service.rs#L7205-L7216),
[L7789-L7798](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/activities/activities_service.rs#L7789-L7798)).
So deleting the fund account's transfer while it's linked would also delete the user's own bank
entry.

## Where and how long

- Undo is offered only on the Done screen of the import just made, for that import as a whole.
- It stays until another statement is read or the add-on is reloaded. It isn't kept in storage, and
  it isn't offered for older imports.
- A later import doesn't make an earlier one undoable again.
- A partial save's Undo covers only what succeeded. A bank entry the import changed into a transfer
  but couldn't link is restored without step 1's unlink.

## Before saving: what it captures

The add-on captures everything Undo would put back before it changes it, so it never has to guess
afterwards. If a capture fails or is incomplete, saving can continue but Undo isn't offered; say why
before saving.

### Detailed statements

For each reused bank entry, its complete state from `activities.getAll`:

- its type: a withdrawal, a deposit or an unlinked transfer.
- its account, amount, date, currency, subtype, comment and metadata. The metadata includes the
  transfer marker `flow.is_external`
  ([`activities_constants.rs` L24-L34](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/activities/activities_constants.rs#L24-L34)).
  Linking sets that marker to false
  ([`repository.rs` L1191-L1200](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L1191-L1200))
  and unlinking sets it to true
  ([L798-L811](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L798-L811)).
  A transfer without the marker counts as internal
  ([L589-L599](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L589-L599)).
- its `isUserModified` flag.
- whether it has spending splits.
- for an entry the import changes into a transfer, in an account in Spending, each spending or
  income category it removes (#220), as Wealthfolio's own conversion does
  ([`repository.rs` L479-L514](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L479-L514)).
  Capture each one's kind, category ID and `source`
  ([`data-types.ts` L710-L719](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/data-types.ts#L710-L719)).
  Match its taxonomy ID and category ID against `spending.getCategories` to get the kind.
  Also capture the entry's original `cashFlowBucket` from `spending.searchCashActivities`
  ([L762-L768](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/data-types.ts#L762-L768)).
  A savings category stays on the entry.

It also captures every existing quote the import can overwrite. For each fund priced by hand, that's
the asset's quote on each date a trade of it is imported, read with `quotes.getHistory`.

### Holdings statements

For each account:

- the snapshot on the statement's date, if one exists: its info, and its positions and cash from
  `snapshots.getByDate`.
- the list of the account's snapshot dates, from `snapshots.getAll`, ignoring `CALCULATED` snapshots
  as the import already does ([`holdings-import.tsx` L113-L116](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/pages/holdings-import.tsx#L113-L116)).
- each quote the import overwrites on that date.
- the whole profile of each existing asset whose details it changes.
- each add-on record it rewrites: imports, unlisted sources and the source index. That's the value
  under each storage key, or that the key had none.

For every snapshot read, the returned position and cash-currency counts must match its info.
`getByDate` can omit positions and tiny cash balances
([`holdings_service.rs` L1361-L1373](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/portfolio/holdings/holdings_service.rs#L1361-L1373),
[L1444-L1448](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/portfolio/holdings/holdings_service.rs#L1444-L1448)).
Capture and compare each position's asset ID, quantity, local currency, local cost basis and
`contractMultiplier`, and each cash balance's currency and quantity, not the profile details or
base-currency values returned alongside them. The host returns `contractMultiplier` even though the SDK's Holding type omits it
([`holdings_service.rs` L1408-L1420](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/portfolio/holdings/holdings_service.rs#L1408-L1420)).
If a snapshot to put back has a multiplier other than one, or it can't be read, Undo isn't offered:
`snapshots.save` always writes one ([`manual_snapshot_service.rs` L353-L370](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/portfolio/snapshot/manual_snapshot_service.rs#L353-L370)).
Snapshot quantities and costs, and quote prices, are exposed as numbers; Undo can't recover decimal
precision those reads lost ([`data-types.ts` L889-L903](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/data-types.ts#L889-L903),
[L997-L1008](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/data-types.ts#L997-L1008)).

### When Undo isn't offered, said before saving

An import doesn't offer Undo when it reuses a bank entry that:

- **has spending splits, or might have.** Changing an entry's type drops its splits
  ([`repository.rs` L267-L275](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L267-L275),
  applied at [L1599-L1604](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L1599-L1604)),
  and the SDK can't write them back. Splits are read with `spending.searchCashActivities`
  ([`host-api.ts` L545-L554](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L545-L554)).
  That only covers accounts enabled for Spending; read every page and match the entry by ID. When
  the call fails, or doesn't return the entry, whether it has splits is unknown, and that counts the
  same as having them. Turning Spending off, or taking the account out of it, doesn't remove splits
  ([`settings/service.rs` L62-L90](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/spending/src/settings/service.rs#L62-L90)).
- **had `isUserModified` false, or unknown.** Linking, unlinking and any update set it to true
  (linking: [`repository.rs` L1195](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L1195);
  unlinking: [L806](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L806);
  updating: [`model.rs` L741-L742](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/model.rs#L741-L742)).
  No SDK update can set it back. Later corrections from a synced source skip entries marked so
  ([`repository.rs` L3242-L3253](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L3242-L3253)).
- **would lose a category the user didn't set, or might.** That covers a spending or income
  category removed when the entry becomes a transfer whose `source` isn't `manual`, such as one a
  categorization rule set, and categories that couldn't be read. `spending.assignCategory` can put a
  category back only as the user's own choice
  ([`host-api.ts` L521-L526](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L521-L526),
  [`activity_assignments/service.rs` L92-L109](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/spending/src/activity_assignments/service.rs#L92-L109)).
  Rules leave a `manual` category alone when they run again
  ([`spending/activity_assignments.rs` L172-L176](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/spending/activity_assignments.rs#L172-L176)),
  so a rule-set category put back that way would stop following rules. This holds until
  Wealthfolio offers a way to put a category back with its source.
- **would lose a category that doesn't fit its original cash-flow bucket.** Only an `expense`
  category on a `spending` entry, or an `income` category on an `income` entry, can be put back.
  A category can remain after an entry's type changes; `assignCategory` rejects one that doesn't
  fit ([`cash_activities/service.rs` L1283-L1321](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/spending/src/cash_activities/service.rs#L1283-L1321)).

In each case the import says so beside the entry before saving, while the user can still untick
it. Undo for bank reuse is offered only when every reused entry's flag was already true, none has
splits, and every category it removes was set by the user and fits the entry's original bucket.

As a result, Undo for bank reuse is rare. Wealthfolio creates every activity with
`isUserModified` false
([`model.rs` L652](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/model.rs#L652)),
so an entry typed in by hand or imported from a file qualifies only once it has been edited, linked
or unlinked in Wealthfolio. Splits also stay unknown for an entry in an account that isn't enabled
for Spending.

Spending edits don't change an activity's `updatedAt`, so Undo checks them separately on the cash
entries it would restore or delete in Cash or Credit card accounts, the only ones Spending covers.
Those edits are a category, a split or an event tag. Spending can edit an entry only while
Spending is on and the entry's account is in it
([`cash_activities/service.rs` L1235-L1258](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/spending/src/cash_activities/service.rs#L1235-L1258)).
So an account that's out of Spending both after saving and when Undo runs needs no such check, and
doesn't stop Undo. An edit made while the account was put into Spending and taken out again in
between can't be detected.

## After saving: what it records

Each thing below is read back from Wealthfolio after every import, create, update, link and
category removal has finished. Values taken earlier aren't used. `activities.import` returns no
`updatedAt`
([`data-types.ts` L427-L527](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/data-types.ts#L427-L527)),
and linking changes both legs' timestamps
([`repository.rs` L1191-L1200](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L1191-L1200)),
so an earlier value would make an untouched import look edited.

- **Activities.** The ID and `updatedAt` of every activity the import created: those carrying its
  `importRunId`, and the fund account's transfers `activities.create` returned. Also those of every
  bank entry it changed. If the activities carrying the `importRunId` don't match the rows the
  import reports as imported one for one, by `sourceRecordId`, Undo isn't offered. Matching accounts
  for the `addon:cas-importer:` prefix on persisted IDs, removed from returned import rows
  ([`type-bridge.ts` L475-L492](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/apps/frontend/src/addons/type-bridge.ts#L475-L492)).
- **Every activity in each affected account.** The ID and `updatedAt` of each activity in every
  account the import wrote to: activity accounts, bank accounts and holdings accounts. This
  catches a later sale of imported units on another device without working out what depends on
  what.
- **Snapshots, for holdings imports.** The saved snapshot's info, positions and cash, the account's
  snapshot dates, and the info, positions and cash of any snapshots on later dates already present.
- **Spending fields of cash entries Undo would restore or delete in Cash or Credit card accounts.**
  For an account in Spending after saving, record their assignments, splits and `eventId` with
  `spending.searchCashActivities`, reading every page and matching by ID. Record whether Spending
  is on and which accounts are in it (`spending.getContext`). This includes newly created bank
  transfers; a transfer on an account in Spending is still listed
  ([`cash_activities/service.rs` L1444-L1458](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/spending/src/cash_activities/service.rs#L1444-L1458)).
  These accounts support Spending
  ([`accounts_constants.rs` L60-L67](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/accounts/accounts_constants.rs#L60-L67)).
  These edits don't change the activity's `updatedAt`
  ([assignments L450-L490](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/spending/activity_assignments.rs#L450-L490),
  [splits L268-L285](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/spending/activity_splits.rs#L268-L285),
  [events L92-L137](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/spending/activity_events.rs#L92-L137)).
- **Everything else Undo would restore.** The final values of every quote, asset profile and
  add-on record it would put back. For a detailed import, that's the quotes captured before saving.

If any read-back fails, is incomplete or can't identify what succeeded, Undo isn't offered.

## When it refuses

Undo refuses, changing nothing, when:

- an activity in an affected account was added, edited or removed after saving. Each one's ID and
  `updatedAt` are compared with the recorded ones. That covers an activity the import created being
  edited or deleted, and a reused bank entry being edited, unlinked or deleted.
- an account's snapshot on the statement's date, or one on a later date, differs from its recorded
  info, positions or cash, or isn't there.
- the account's snapshot dates differ from the recorded list, such as a snapshot saved on a later
  date.
- a quote, asset profile or add-on record it would restore was changed or removed since.
- a cash entry's assignments, splits or event tag differ from the recorded ones, or can't be read,
  in an account that's in Spending after saving or when Undo runs. An entry in an account that was
  out of Spending after saving counts as having none recorded. A reused entry must still have no
  splits.
- a category to put back can't be: Spending was turned off, the entry's account was taken out of
  it, or the category no longer exists under its captured kind (`spending.getContext`,
  `spending.getCategories`).
  `spending.assignCategory` refuses those
  ([`cash_activities/service.rs` L887-L935](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/spending/src/cash_activities/service.rs#L887-L935),
  [L1235-L1258](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/spending/src/cash_activities/service.rs#L1235-L1258)).
- an account the import created or wrote to was archived or deleted.
- reading back any of these fails.

Every check runs again right before Undo changes anything, so edits made on another synced device
count too. After a refusal, Undo stays on the Done screen, and each press runs every check again.
These checks don't lock other devices: SDK 3.13.0 has no conditional writes or transaction across
these calls ([`host-api.ts` L194-L212](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L194-L212),
[L1026-L1043](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L1026-L1043)).
The confirmation says "Avoid editing these accounts on another device while Undo runs." A snapshot
saved again with the same visible contents can't be detected.

## What it restores, in this order

1. **Each reused bank entry.**
   - Unlink it from the fund account's transfer with `activities.unlinkTransfer`.
   - Restore its captured type, account, amount, date, currency, subtype, comment and metadata with
     `activities.update`.

   Send the captured fields on both updates:
   - an update clears a comment it isn't sent, as `linkBankRow` already allows for
     ([`repository.rs` L303-L326](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/activities/repository.rs#L303-L326)
     keeps other fields, not the comment).
   - metadata object patches merge top-level keys and can't remove an omitted key
     ([`activities_service.rs` L4191-L4208](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/activities/activities_service.rs#L4191-L4208)).
     So send each top-level key of the captured metadata, `flow` included. When the captured entry
     was a transfer with no `flow`, send `flow` as `{ "is_external": false }`, which reads the same.
     Treat those two forms as equivalent when checking the restored entry.
   - changing a transfer back into a withdrawal or deposit removes `flow.is_external` and
     `transfer`, and clears the subtype
     ([L905-L983](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/activities/activities_service.rs#L905-L983)).

   Then read the entry back. If its subtype or metadata still differs, send a second update of the
   same type with the captured fields. Check all restored fields using the equivalence above and
   treating absent metadata and `{}` as equivalent: reclassification can leave an empty object.
   Anything still different is a failure part-way.

   Then put back each category the import removed, with `spending.assignCategory` and the captured
   kind and category ID. It needs the entry back in its spending or income bucket, so this comes
   after the type is restored
   ([`cash_activities/service.rs` L904-L911](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/spending/src/cash_activities/service.rs#L904-L911)).
   Read the categories back: each must be there, with `source` `manual`, as it was captured.
2. **Every activity the import created.** Delete them in one `activities.saveMany`. This comes after
   step 1, so no linked pair takes a user's entry with it.
   Require an empty `errors` array and exactly the expected deleted IDs
   ([`data-types.ts` L362-L368](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/data-types.ts#L362-L368));
   otherwise stop and report the confirmed outcome.
3. **Each holdings account's snapshot.** If one existed on that date, put the captured one back with
   `snapshots.save`, each holding by its asset ID and without a `dataSource`. With a `dataSource`
   of `MANUAL`, the save would switch a market-priced asset to prices by hand
   ([`manual_snapshot_service.rs` L307-L316](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/portfolio/snapshot/manual_snapshot_service.rs#L307-L316)).
   Send each quantity and cash balance as a string; derive average cost from local cost basis divided
   by quantity with the add-on's decimal arithmetic, not base-currency cost or JavaScript division.
   Otherwise, delete the date with `snapshots.delete`.
   Confirm that the date is absent or its positions and cash match the capture, and read its persisted
   source for the result wording. A mismatch or failed check is a failure part-way.
4. **Each overwritten quote and changed asset profile**, from what was captured.
   - Write each quote with `quotes.update`.
   - Write each profile whole with `assets.updateProfile`. Omitted name, display code and provider
     configuration are cleared; an omitted price mode goes back to market
     ([`assets/repository.rs` L238-L271](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/assets/repository.rs#L238-L271)).
     Omitted or null metadata preserves the current details, so send `{}` when the captured metadata
     was absent ([L188-L194](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/storage-sqlite/src/assets/repository.rs#L188-L194)).
     Send `notes: profile.notes ?? ""`, as the import does
     ([`holdings-import.tsx` L249-L260](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/src/pages/holdings-import.tsx#L249-L260)).
     Read it back, treating absent metadata and `{}`, and absent notes and `""`, as equivalent;
     a difference is a failure part-way.
5. **The add-on's own records.** Set each captured value back, and delete each key that had none.

## What it leaves

These are said on the confirmation and again after Undo:

- **accounts it created.** The SDK can't delete them. If Undo removes everything in one, it stays
  empty.
- **assets it created.**
- **quotes it added where there were none.** That covers prices the import wrote and average costs
  a snapshot save wrote.
- **remembered fund and account choices.** These are preferences.
- **a replaced snapshot's source, when putting it back rewrites it.** The save requests one entered
  by hand (`MANUAL_ENTRY`,
  [`manual_snapshot_service.rs` L262](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/portfolio/snapshot/manual_snapshot_service.rs#L262)),
  whatever its source was. If its financial contents are unchanged, the host skips the write and
  keeps the existing source ([`snapshot_service.rs` L777-L795](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/portfolio/snapshot/snapshot_service.rs#L777-L795)).
  The confirmation names a source change only when a rewrite is needed; the result uses the source
  read back.

Each is named, with "You can delete them in Wealthfolio" where that's possible: accounts, assets and
prices, not remembered choices.

## If a step fails part-way

- Stop.
- List what was put back and what wasn't, per account. If a failed call may have written, read it
  back; if that fails too, say what couldn't be checked, without retrying the write.
- Don't offer Undo again.
- Name what to fix by hand, such as "Unlink the transfer of 5 Jan 2026 in Savings account".

## Wording

Write one line per account, from its real previous state. Use the add-on's account and fund
names, and dates as "31 Jul 2026".

**Done screen note**, beside **Undo this import** or **Undo this update**: "You can undo this import
until you read another statement." For holdings: "You can undo this update until you read another
statement." When Undo isn't offered, the note says why, in the words used before saving.

**Before saving**, beside a reused entry that stops Undo:

- "Using this entry means this import can't be undone: it's split across spending categories, and
  changing its type deletes the split." For an unlinked transfer: "… the add-on can't put spending
  splits back."
- "Using this entry means this import can't be undone: the add-on can't check whether it has
  spending splits."
- "Using this entry means this import can't be undone: linking marks it as changed by you, which
  Undo can't reverse."
- "Using this entry means this import can't be undone: a rule set its spending category, which
  changing it into a transfer removes, and Undo could put it back only as chosen by you." For a
  category that couldn't be read: "… the add-on can't check who set its category, which changing
  it into a transfer removes." Say "income" for an income category.
- "Using this entry means this import can't be undone: its spending category doesn't fit this
  deposit, so Undo couldn't put it back." Say "income" and "withdrawal" for the other case.


**Confirmation.** Use Wealthfolio's AlertDialog, titled "Undo this import?" or "Undo this update?".
Its lines:

- "CDSL Demat: back to its holdings from 30 Jun 2026; the holdings saved for 31 Jul 2026 are
  removed."
- "CDSL Demat: puts back the holdings saved for 31 Jul 2026 before this replacement."
- "Fictiva folio: removes the holdings this import saved; the new account will be empty."
- "Deletes the 128 transactions this import added, and turns the 4 Savings account entries it
  linked back into the withdrawals they were." With deposits, or both: "the deposits they were",
  "the withdrawals and deposits they were". With entries that were unlinked transfers: "unlinks the
  2 Savings account transfers it linked". When the import removed their categories, add "with
  their spending categories" (or "income", or "spending and income").
- "Stays: the account Fictiva folio, Fictiva Balanced Advantage Fund, prices saved on 31 Jul 2026.
  You can delete them in Wealthfolio."
- When putting back a snapshot will change its source: "CDSL Demat: the holdings put back for
  31 Jul 2026 are saved as entered by hand."

Its buttons are **Keep import** and **Undo import**, or **Keep update** and **Undo update**. The
initial focus is on Keep, not the destructive action. Escape cancels, and the focus goes back to
Undo.

**Result**, after Undo: "Undone." with the same lines in the past tense. For example:

- "CDSL Demat: back to its holdings from 30 Jun 2026; the holdings saved for 31 Jul 2026 were
  removed."
- "Deleted the 128 transactions this import added, and turned the 4 Savings account entries it
  linked back into the withdrawals they were."

Then the Stays line.

**Part-way failure:** "Undo stopped part-way: {error}." Then, per account, "Put back: …", "Not put
back: …" and "Fix by hand: Unlink the transfer of 5 Jan 2026 in Savings account."

**Refusals** start "Nothing was undone." and end with an **Open {account}** button:

- "A transaction this import added to Fictiva folio was edited or deleted since."
- "The Savings account entry of 5 Jan 2026 that this import linked was edited, unlinked or deleted
  since."
- "An activity in Savings account was added, edited or deleted after this import."
- "The holdings of CDSL Demat for 31 Jul 2026 were changed or removed after this update."
- "Holdings were saved or removed for CDSL Demat on another date after this update."
- "The holdings of CDSL Demat on a later date were changed after this update."
- "The price of Fictiva Balanced Advantage Fund on 31 Jul 2026 was changed after this import."
- "The details of Fictiva Balanced Advantage Fund were changed after this update."
- "The add-on's records for CDSL Demat were changed after this update, by another import perhaps."
- "The category of the Savings account entry of 5 Jan 2026 was changed after this import."
- "The split or event tag of the Savings account entry of 5 Jan 2026 was changed after this import."
- "The Savings account entry of 5 Jan 2026 can't get its spending category back: Spending is off,
  or Savings account isn't in it." Or "… its category Investments no longer exists."
- "Fictiva folio was archived after this import." Or "… was deleted …", with no button.
- "Couldn't check Savings account for changes since this import: {error}." Its button is **Try
  again**, alongside **Open Savings account**.

## Permissions

Undo needs these functions, which `manifest.json` doesn't request yet
([L35-L81](https://github.com/jay-tau/wealthfolio-cas-importer/blob/46749bf/manifest.json#L35-L81)).
Each joins its category's `functions`, and a sentence is added to that category's `purpose`.

| Category | Function | Purpose sentence |
| --- | --- | --- |
| `activities` | `saveMany` | "Undo an import you just made: delete the transactions it added." |
| `activities` | `unlinkTransfer` | "Undo an import that used a bank account's deposit or withdrawal: unlink it from the fund's transfer and turn it back into what it was." |
| `activities` | `searchCashActivities` | "Check cash entries for splits and Spending changes before Undo; changing a reused entry's type deletes splits the add-on can't put back." |
| `activities` | `assignCategory` | "Undo an import you just made: put back the spending or income category of each bank entry it changed into a transfer." |
| `spending` | `getContext` | "Check whether a bank account is in Spending." |
| `spending` | `getCategories` | "Check which kind a category belongs to and that Undo can still put it back." |
| `snapshots` | `delete` | "Undo a holdings import you just made: remove the holdings it saved on a date that had none." |

`searchCashActivities` is the high-risk read that returns an entry's splits and categories
([`host-api.ts` L545-L554](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L545-L554)).
It's needed for the splits and category checks above. `assignCategory` is high-risk too
([L521-L526](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/packages/addon-sdk/src/host-api.ts#L521-L526)).
#220 adds `searchCashActivities` and `getContext`, with `unassignCategory`.

Wealthfolio compares permissions by category and function
([`service.rs` L2756-L2776](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/addons/service.rs#L2756-L2776)).
An update that adds any of these isn't installed automatically: it asks every user to approve a
reinstall
([L2778-L2813](https://github.com/wealthfolio/wealthfolio/blob/v3.13.0/crates/core/src/addons/service.rs#L2778-L2813)).

If Phase 3 is ready by then, ship these in the same release as Phase 2's `accounts.create`, so users
approve once. Otherwise, announce the reinstall in that release's notes. If another change adds one
of them first, Phase 3 adds only the rest.

## Tests Phase 3 needs

The browser test's fake host has to model:

- deleting a linked pair whole.
- `unlinkTransfer`, setting `flow.is_external` true and `isUserModified` true.
- `snapshots.delete`.
- `updatedAt` changing on every create, update, link and unlink.
- an update merging metadata object patches and clearing an unsent comment.
- a cash reclassification clearing the subtype and transfer metadata, leaving `{}` when nothing
  remains.
- a null profile metadata update preserving details, and `{}` clearing them.
- `saveMany` resolving with errors rather than throwing.
- a snapshot ID that stays the same when the snapshot is saved again on that date.
- category assignments with their `source`, `assignCategory` writing `manual`, and Spending's
  account scope.
- category, split and event-tag edits leaving the activity's `updatedAt` unchanged.

Then test:

- each refusal above, including changed holdings on the same date or an already-existing later date.
- incomplete captures and read-backs, including an omitted position or cash balance.
- a snapshot to put back with a non-unit or unreadable contract multiplier. Undo isn't offered.
- a failure at each step, part-way.
- Undo of an import that replaced a same-date snapshot.
- Undo of an import into an account with no earlier snapshot.
- Undo right after reusing bank entries. It must not refuse.
- a reused entry that was a withdrawal with a comment and a subtype. All of them come back.
- a reused withdrawal or deposit with no metadata. Undo accepts the empty object left by
  reclassification.
- a reused entry that was an unlinked transfer whose external marker was absent, false or true. It's
  restored as it was.
- a reused withdrawal with a spending category, and a deposit with an income category, both set
  by the user: Undo puts each back, as the user's. One with a savings category: it was never
  removed, and stays.
- a reused entry whose removed category a rule set, or whose categories can't be read. Undo isn't
  offered, and the import says so before saving.
- after saving: a reused entry's category changed, Spending turned off, the account taken out of
  Spending, or the category deleted or moved to another kind. Undo must refuse.
- a removed manual category that doesn't fit the entry's original bucket. Undo isn't offered.
- after saving: splits added to a reused bank transfer with no assignments, or a category, split or
  event tag changed on a newly created bank transfer, without changing the activity's `updatedAt`.
  Undo must refuse. Cash entries added to an account out of Spending, which stays out: Undo is
  offered and works. That account put into Spending after saving and an entry categorized: Undo
  must refuse.
- a detailed purchase that overwrote an existing manual quote. Undo puts the original price back. A
  quote it added where there was none stays and is named.
- an entry with spending splits, one whose splits can't be read, and one with `isUserModified`
  false. In each case Undo isn't offered, and the import says so before saving.
- another activity added to an affected account after saving. Undo must refuse.
- a quote, profile or record edited after saving. Undo must refuse.
- a partial save. Its Undo covers only what succeeded, including an entry changed but not linked.
- a profile whose metadata and notes were absent before the import. Its added details are removed.
- an unchanged snapshot save. The result names the source actually kept.
- the confirmation's focus: it starts on Keep, Escape cancels, and the focus returns to Undo.
