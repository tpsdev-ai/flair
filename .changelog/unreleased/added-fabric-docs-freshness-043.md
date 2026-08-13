- **Fabric deployment docs corrected for 5.2+.** Fixed ops-API port (9925, same hostname),
  clarified cluster_status availability on Fabric, documented the mcp.enabled manual flip
  and its upgrade-reverts trap, and versioned log paths (hdb.log froze at 5.2, system.log
  is the live log 5.2+). Closes #1153, #1156, #1157.
