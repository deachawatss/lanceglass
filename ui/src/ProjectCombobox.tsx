import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

type Facet = { value: string; count: number };

type Props = {
  facets: Facet[];
  value: string;
  onChange: (value: string) => void;
  shortcut: string;
};

const MAX_VISIBLE_OPTIONS = 100;

export const ProjectCombobox = forwardRef<HTMLInputElement, Props>(
  function ProjectCombobox({ facets, value, onChange, shortcut }, forwardedRef) {
    const input = useRef<HTMLInputElement>(null);
    const root = useRef<HTMLDivElement>(null);
    const listId = useId();
    const labelId = useId();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState(value);
    const [active, setActive] = useState(0);

    const connectInput = useCallback((node: HTMLInputElement | null) => {
      input.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    }, [forwardedRef]);

    const options = useMemo(() => {
      const needle = query.trim().toLocaleLowerCase();
      const projects = facets.filter((facet) =>
        !needle || facet.value.toLocaleLowerCase().includes(needle),
      );
      const allMatches = !needle || "all projects".includes(needle);
      return [
        ...(allMatches ? [{ value: "", count: 0 }] : []),
        ...projects,
      ].slice(0, MAX_VISIBLE_OPTIONS);
    }, [facets, query]);

    useEffect(() => {
      if (!open) setQuery(value);
    }, [open, value]);

    useEffect(() => {
      if (!open) return;
      const selected = options.findIndex((option) => option.value === value);
      setActive(selected >= 0 ? selected : 0);
    }, [open, options, value]);

    useEffect(() => {
      if (!open) return;
      const close = (event: PointerEvent) => {
        if (!root.current?.contains(event.target as Node)) {
          setOpen(false);
          setQuery(value);
        }
      };
      document.addEventListener("pointerdown", close);
      return () => document.removeEventListener("pointerdown", close);
    }, [open, value]);

    const choose = (next: string) => {
      onChange(next);
      setQuery(next);
      setOpen(false);
      input.current?.focus();
    };

    return (
      <div className="field-label project-combobox" ref={root}>
        <span className="field-label-row" id={labelId}>
          <span>Project / Oracle</span>
          <kbd aria-hidden="true">{shortcut}</kbd>
        </span>
        <input
          ref={connectInput}
          data-testid="project-filter"
          role="combobox"
          aria-labelledby={labelId}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          placeholder="all projects"
          value={query}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onBlur={() => {
            window.setTimeout(() => {
              if (!root.current?.contains(document.activeElement)) {
                setOpen(false);
                setQuery(value);
              }
            });
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActive((current) => {
                if (!options.length) return 0;
                return (current + direction + options.length) % options.length;
              });
              return;
            }
            if (event.key === "Home" && open) {
              event.preventDefault();
              setActive(0);
              return;
            }
            if (event.key === "End" && open) {
              event.preventDefault();
              setActive(Math.max(0, options.length - 1));
              return;
            }
            if (event.key === "Enter" && open && options[active]) {
              event.preventDefault();
              choose(options[active].value);
              return;
            }
            if (event.key === "Escape" && open) {
              event.preventDefault();
              setOpen(false);
              setQuery(value);
              input.current?.select();
              return;
            }
            if (event.key === "Tab") {
              setOpen(false);
              setQuery(value);
            }
          }}
        />
        {open && (
          <ul className="project-options" id={listId} role="listbox">
            {options.map((option, index) => (
              <li
                id={`${listId}-${index}`}
                key={option.value || "all"}
                role="option"
                aria-selected={option.value === value}
                className={index === active ? "is-active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option.value)}
              >
                <span>{option.value || "all projects"}</span>
                {option.value && <small>{option.count.toLocaleString()}</small>}
              </li>
            ))}
            {!options.length && (
              <li className="project-options-empty" role="option" aria-disabled="true">
                No project / oracle found
              </li>
            )}
          </ul>
        )}
      </div>
    );
  },
);
