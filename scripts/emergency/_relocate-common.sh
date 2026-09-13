#!/bin/sh
#
# Shared helpers for relocate-stack-paths (SQLite + PostgreSQL variants source this).
# Contains the pure re-anchor rule and the interactive/dry-run presentation, so the
# only difference between the two DB variants is how they read/write the database.
#
# The DB variant must define, before sourcing this file:
#   db_list_stack_paths   -> prints one row per (compose|env) path as:
#                              <id>\t<field>\t<label>\t<stored_path>
#                            (field = "compose" or "env"; label = human name)
#   db_list_external_paths -> prints one line per external_stack_paths entry:
#                              <index>\t<stored_path>
#   db_update_stack_path <id> <field> <new_path>   -> UPDATE that one column
#   db_update_external_path <index> <new_path>      -> replace that array entry
#
# It reads: OLD_DIR, NEW_DIR, MODE (dry|apply), APPLY_ALL (0|1).

# --- pure re-anchor rule: rewrite a stored path from the old DATA_DIR prefix to the
#     new one, matching only on a full path segment (so /app/data never matches
#     /app/database), with a single trailing slash stripped from each dir. ---

# strip a single trailing slash
_strip_trailing_slash() { printf '%s' "$1" | sed 's:/*$::'; }

# rewrite_under_data_dir <stored> <oldDir> <newDir>
# Prints the rewritten path, or nothing when <stored> is not under <oldDir> (segment
# boundary, so /app/data never matches /app/database) or the rewrite is a no-op.
rewrite_under_data_dir() {
    stored="$1"; old="$(_strip_trailing_slash "$2")"; new="$(_strip_trailing_slash "$3")"
    [ -z "$stored" ] && return 0
    [ -z "$old" ] && return 0
    [ "$old" = "$new" ] && return 0
    if [ "$stored" = "$old" ]; then printf '%s' "$new"; return 0; fi
    case "$stored" in
        "$old"/*) printf '%s%s' "$new" "${stored#"$old"}" ;;
        *) return 0 ;;  # not under old dir - leave it
    esac
}

# classify_path <stored> : echoes "STATUS\tNEWPATH\tREASON"
#   WILL_UPDATE  <new>  ""        - old missing AND new exists
#   SKIP         ""     outside   - not under the old DATA_DIR (NEWPATH is empty)
#   SKIP         <new>  oldexists - old file still present (adopted/not moved)
#   SKIP         <new>  newmissing - rewritten target not on disk yet
classify_path() {
    stored="$1"
    new="$(rewrite_under_data_dir "$stored" "$OLD_DIR" "$NEW_DIR")"
    if [ -z "$new" ]; then
        printf 'SKIP\t\toutside'
        return 0
    fi
    if [ -e "$stored" ]; then
        printf 'SKIP\t%s\toldexists' "$new"
        return 0
    fi
    if [ ! -e "$new" ]; then
        printf 'SKIP\t%s\tnewmissing' "$new"
        return 0
    fi
    printf 'WILL_UPDATE\t%s\t' "$new"
}

_reason_text() {
    case "$1" in
        outside) printf 'outside the old DATA_DIR - left as-is' ;;
        oldexists) printf 'old file still exists - not stale, left as-is' ;;
        newmissing) printf 'new file not found (copy the files across first)' ;;
        *) printf '%s' "$1" ;;
    esac
}

# --- header ---
print_header() {
    echo "========================================================================"
    echo "  Dockhand - Relocate stack paths ($DB_LABEL)"
    echo "========================================================================"
    echo ""
    echo "  Updates where Dockhand LOOKS FOR each stack's compose/env files in its"
    echo "  database, after you changed DATA_DIR."
    echo ""
    echo "  >> It does NOT move, copy, or delete any files. Your files are untouched."
    echo "     It only rewrites the stored path in the database. A pointer is changed"
    echo "     only when the old file is gone AND the new file already exists on disk."
    echo ""
    echo "  Old DATA_DIR:  $OLD_DIR"
    echo "  New DATA_DIR:  $NEW_DIR"
    [ -n "$DB_DISPLAY" ] && echo "  Database:      $DB_DISPLAY"
    echo ""
    if [ "$MODE" = "apply" ]; then
        echo "  >> Make a database backup before proceeding if you want a safety net."
        echo ""
    fi
}

# --- main pass: build a work list, present it, and (in apply mode) apply it ---

run_relocation() {
    will=0; applied=0; declined=0
    # Collect WILL_UPDATE items into a temp file: <kind>\t<id-or-index>\t<field>\t<label>\t<old>\t<new>
    worklist="$(mktemp)"

    print_header
    echo "------------------------------------------------------------------------"

    # stack_sources rows
    db_list_stack_paths | while IFS='	' read -r id field label stored; do
        [ -z "$stored" ] && continue
        res="$(classify_path "$stored")"
        status="$(printf '%s' "$res" | cut -f1)"
        new="$(printf '%s' "$res" | cut -f2)"
        reason="$(printf '%s' "$res" | cut -f3)"
        if [ "$status" = "WILL_UPDATE" ]; then
            printf 'stack\t%s\t%s\t%s\t%s\t%s\n' "$id" "$field" "$label" "$stored" "$new" >> "$worklist"
            printf '  %-22s %-8s WILL UPDATE\n' "$label" "$field"
            printf '     %s\n  -> %s\n' "$stored" "$new"
        else
            printf '  %-22s %-8s SKIP  (%s)\n' "$label" "$field" "$(_reason_text "$reason")"
            printf '     %s\n' "$stored"
        fi
    done

    # external_stack_paths entries
    db_list_external_paths | while IFS='	' read -r idx stored; do
        [ -z "$stored" ] && continue
        res="$(classify_path "$stored")"
        status="$(printf '%s' "$res" | cut -f1)"
        new="$(printf '%s' "$res" | cut -f2)"
        reason="$(printf '%s' "$res" | cut -f3)"
        if [ "$status" = "WILL_UPDATE" ]; then
            # field is '-' (a placeholder) because a tab-IFS `read` collapses an EMPTY
            # field and would shift every later column.
            printf 'external\t%s\t-\texternal_stack_paths[%s]\t%s\t%s\n' "$idx" "$idx" "$stored" "$new" >> "$worklist"
            printf '  %-22s %-8s WILL UPDATE\n' "external_stack_paths[$idx]" ""
            printf '     %s\n  -> %s\n' "$stored" "$new"
        else
            printf '  %-22s %-8s SKIP  (%s)\n' "external_stack_paths[$idx]" "" "$(_reason_text "$reason")"
            printf '     %s\n' "$stored"
        fi
    done

    echo "------------------------------------------------------------------------"
    will="$(wc -l < "$worklist" | tr -d ' ')"

    if [ "$MODE" = "dry" ]; then
        echo "  Summary: $will will update."
        echo ""
        echo "  This was a DRY RUN. Nothing was changed."
        echo "  To apply, re-run with --apply (review each change), or --apply --all."
        echo "========================================================================"
        rm -f "$worklist"
        return 0
    fi

    if [ "$will" -eq 0 ]; then
        echo "  Nothing to update."
        echo "========================================================================"
        rm -f "$worklist"
        return 0
    fi

    # Interactive review needs a terminal. Without one (e.g. `docker exec` with no
    # -it), tell the user how to proceed instead of erroring on each prompt.
    if [ "$APPLY_ALL" -ne 1 ] && [ ! -r /dev/tty ]; then
        echo "  No terminal available for interactive review."
        echo "  Re-run with 'docker exec -it ...' to confirm each change, or add --all"
        echo "  to apply all $will change(s) without prompting."
        echo "========================================================================"
        rm -f "$worklist"
        return 1
    fi

    # apply mode. Read the work list on FD 3, not stdin, so a db_update_* helper that
    # happens to touch stdin (e.g. a client that reads it) can't swallow the list.
    i=0
    while IFS='	' read -r kind key field label old new <&3; do
        i=$((i + 1))
        show_field="$field"; [ "$show_field" = "-" ] && show_field=""
        printf '\n  [%s/%s] %s %s\n' "$i" "$will" "$label" "$show_field"
        printf '        %s\n     -> %s\n' "$old" "$new"
        if [ "$APPLY_ALL" -eq 1 ]; then
            ans="y"
        else
            printf '        Apply this change? [y/n/q] '
            read -r ans </dev/tty
        fi
        case "$ans" in
            y|Y)
                if [ "$kind" = "stack" ]; then
                    db_update_stack_path "$key" "$field" "$new"
                else
                    db_update_external_path "$key" "$new"
                fi
                applied=$((applied + 1))
                echo "        ... updated."
                ;;
            q|Q)
                echo "        ... quit."
                break
                ;;
            *)
                declined=$((declined + 1))
                echo "        ... skipped."
                ;;
        esac
    done 3< "$worklist"

    echo ""
    echo "  Done. $applied applied, $declined skipped by you."
    echo "  Restart Dockhand to pick up the changes."
    echo "========================================================================"
    rm -f "$worklist"
}

# --- argument parsing shared by both variants ---
parse_relocate_args() {
    OLD_DIR=""; NEW_DIR=""; MODE="dry"; APPLY_ALL=0
    for arg in "$@"; do
        case "$arg" in
            --apply) MODE="apply" ;;
            --all) APPLY_ALL=1 ;;
            --*) echo "Unknown option: $arg"; exit 2 ;;
            *)
                if [ -z "$OLD_DIR" ]; then OLD_DIR="$arg"
                elif [ -z "$NEW_DIR" ]; then NEW_DIR="$arg"
                else echo "Unexpected argument: $arg"; exit 2
                fi
                ;;
        esac
    done
    if [ -z "$OLD_DIR" ] || [ -z "$NEW_DIR" ]; then
        echo "Usage: relocate-stack-paths.sh <old-data-dir> <new-data-dir> [--apply] [--all]"
        exit 2
    fi
    case "$OLD_DIR" in /*) ;; *) echo "Error: old-data-dir must be an absolute path"; exit 2 ;; esac
    case "$NEW_DIR" in /*) ;; *) echo "Error: new-data-dir must be an absolute path"; exit 2 ;; esac
}
