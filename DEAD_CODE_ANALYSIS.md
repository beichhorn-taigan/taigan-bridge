# Dead Code Analysis - Exported but Unreferenced Functions

Analysis performed by searching the entire `src/` codebase for references to exported functions from the specified script files.

## Summary

**Total Dead Code Items Found: 12**

---

## src/scripts/utils.js

### 1. `TB.utils.shortId` (Line 168)
- **Type:** Function
- **Exported:** Yes
- **Referenced:** No
- **Code:**
  ```javascript
  function shortId(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9);
  }
  ```

### 2. `TB.utils.getFxRate` (Line 228)
- **Type:** Function
- **Exported:** Yes
- **Referenced:** No
- **Code:**
  ```javascript
  function getFxRate() {
    if (!window.TB || !TB.state) throw new Error('State not available');
    // ... implementation returns hardcoded rate
  }
  ```

---

## src/scripts/state.js

### 3. `TB.state.PREV_KEY` (Line 1393)
- **Type:** Constant
- **Exported:** Yes
- **Referenced:** No
- **Value:** `'taigan-bridge-state-prev'`
- **Note:** Used internally within state.js for backup management but not accessed externally

### 4. `TB.state.CORRUPT_KEY` (Line 1394)
- **Type:** Constant
- **Exported:** Yes
- **Referenced:** No
- **Value:** `'taigan-bridge-state-corrupt'`
- **Note:** Used internally within state.js but not accessed externally

### 5. `TB.state.CURRENT_VERSION` (Line 1395)
- **Type:** Constant
- **Exported:** Yes
- **Referenced:** No
- **Value:** `4`
- **Note:** Used internally within state.js migrations but not accessed externally

### 6. `TB.state.subscribe` (Line 1398)
- **Type:** Function
- **Exported:** Yes
- **Referenced:** No
- **Code:**
  ```javascript
  function subscribe(callback) {
    subscribers.push(callback);
    return () => {
      const i = subscribers.indexOf(callback);
      if (i !== -1) subscribers.splice(i, 1);
    };
  }
  ```

### 7. `TB.state.reset` (Line 1403)
- **Type:** Function
- **Exported:** Yes
- **Referenced:** No
- **Code:**
  ```javascript
  function reset() {
    cache = deepClone(DEFAULT_STATE);
    persist();
    notify('', cache);
  }
  ```

---

## src/scripts/search.js

### 8. `TB.search.buildIndex` (Line 950)
- **Type:** Function
- **Exported:** Yes
- **Referenced:** No
- **Note:** Internal indexing function; search functionality is available but buildIndex is not called externally

### 9. `TB.search.search` (Line 951)
- **Type:** Function
- **Exported:** Yes
- **Referenced:** No
- **Note:** Core search function but appears to be only used internally within search.js

### 10. `TB.search.shortcutLabel` (Line 952)
- **Type:** Function
- **Exported:** Yes
- **Referenced:** No
- **Code:**
  ```javascript
  function shortcutLabel() {
    return isMac() ? '⌘K' : 'Ctrl+K';
  }
  ```

---

## src/scripts/customize.js

### 11. `TB.customize.getSectionState` (Line 192)
- **Type:** Function
- **Exported:** Yes
- **Referenced:** No
- **Code:**
  ```javascript
  function getSectionState(moduleId, sectionId) {
    const override = (TB.state.get('settings.module_customizations') || {})[moduleId];
    if (override && override[sectionId] !== undefined) {
      return override[sectionId] ? 'on' : 'off';
    }
    return 'auto';
  }
  ```
- **Note:** Used internally within customize.js (line 89) but not exported to other modules

---

## Analysis Notes

### Items That Were Initially Suspicious But Are Actually Used:

- **TB.utils.fetchCurrentTreasuryRates** - Used internally in `refreshCurrentFx()` (line 285)
- **TB.utils.fetchExchangerateHost** - Used internally in `refreshCurrentFx()` (line 301)
- **TB.tracks.trackLabel** - Used in `profile.js` module
- **TB.search.open** - Called from `index.html` search button
- **TB.search.close** - Used internally and from index.html
- **TB.search.installShortcut** - Called from `index.html`
- **TB.state.restorePrevious** - Called in settings module
- **TB.state.hasPreviousBackup** - Called in settings module
- **TB.state.clearAll** - Called in settings module

---

## Recommendations

1. **Remove unused exports** to reduce public API surface and improve maintainability
2. **Consider if these were meant for future use** - if not, they can be safely deleted:
   - Remove from exports in each file
   - Delete function definitions if no internal dependencies exist
3. **For state.js constants** - These appear to be configuration values that were exported but never used; consider keeping them if they might be used for debugging/logging in the future
4. **For search.js functions** - Verify if `buildIndex` and `search` should be public API or if they're implementation details that can be kept private

---

## Files Analyzed

- ✓ src/scripts/utils.js
- ✓ src/scripts/state.js
- ✓ src/scripts/search.js
- ✓ src/scripts/tracks.js
- ✓ src/scripts/update-check.js
- ✓ src/scripts/customize.js
- ✓ src/scripts/icons.js
- ✓ src/scripts/sample-data.js
- ✓ src/scripts/hosted-demo.js
- ✓ src/scripts/about-overlays.js
- ✓ src/scripts/ai-client.js
- ✓ src/scripts/integrity.js
