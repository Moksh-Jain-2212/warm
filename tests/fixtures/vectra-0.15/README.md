# Vectra selector and export reference

The selector is the published Vectra 0.15.0 `lib/ItemSelector.js`, normalized to LF. Its MIT license is retained in `LICENSE`; source and normalized hashes are recorded in `provenance.json`. The pinned source is `dec2dadc3bb158b06ac72fa9097bee729429a271`. The production compatibility module copies only its selector methods; this complete reference also retains the upstream vector helpers for an independent differential oracle.

`export/` and `export-api.json` were produced using that real package's `LocalIndex`, `createIndex({version:1, metadata_config:{indexed:['group']}})`, and two `insertItem` calls:

```js
{id:'external', vector:[1,0,0], metadata:{group:'public', private:'original metadata', count:7}}
{id:'inline', vector:[0,1,0], metadata:{group:'private'}}
```

`export-api.json` records `{stats: await source.getIndexStats(), items: await source.listItems()}`. The generated UUID is incidental; the test reads the recorded filename. The portable fixture reader exercises those recorded public return shapes and sidecar bytes against the real WARM native implementation; it does not emulate WARM storage or search.
