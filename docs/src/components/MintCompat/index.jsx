import React from "react";
import Link from "@docusaurus/Link";
import ThemeTabs from "@theme/Tabs";
import ThemeTabItem from "@theme/TabItem";
import {
  Activity,
  Apple,
  CirclePlay,
  Download,
  FileText,
  FolderPlus,
  Info,
  KeyRound,
  LayoutDashboard,
  MonitorDown,
  PlayCircle,
  Settings,
  SlidersHorizontal,
  Users,
  Webhook,
  TriangleAlert,
} from "lucide-react";
import styles from "./styles.module.css";

const icons = {
  activity: Activity,
  apple: Apple,
  "circle-play": CirclePlay,
  download: Download,
  "folder-plus": FolderPlus,
  "key-round": KeyRound,
  "layout-dashboard": LayoutDashboard,
  "monitor-down": MonitorDown,
  "play-circle": PlayCircle,
  settings: Settings,
  "sliders-horizontal": SlidersHorizontal,
  users: Users,
  webhook: Webhook,
};

export function Steps({ children }) {
  return <div className={styles.steps}>{children}</div>;
}

export function Step({ title, children }) {
  return (
    <section className={styles.step}>
      <div className={styles.stepMarker} aria-hidden="true" />
      <div className={styles.stepBody}>
        <h3 className={styles.stepTitle}>{title}</h3>
        <div className={styles.stepContent}>{children}</div>
      </div>
    </section>
  );
}

export function Columns({ cols = 2, children }) {
  return (
    <div className={styles.columns} style={{ "--column-count": Math.max(1, Number(cols) || 1) }}>
      {children}
    </div>
  );
}

export function Card({ title, icon, href, cta, children }) {
  const Icon = icons[icon] ?? FileText;
  return (
    <Link className={styles.card} to={href}>
      <span className={styles.cardIcon} aria-hidden="true"><Icon size={19} strokeWidth={1.8} /></span>
      <span className={styles.cardBody}>
        <strong className={styles.cardTitle}>{title}</strong>
        <span className={styles.cardContent}>{children}</span>
        {cta ? <span className={styles.cardCta}>{cta}<span aria-hidden="true"> →</span></span> : null}
      </span>
    </Link>
  );
}

export function Tabs({ children }) {
  const items = React.Children.toArray(children)
    .filter(React.isValidElement)
    .map((child, index) => {
      const title = child.props.title ?? `Tab ${index + 1}`;
      const value = String(child.props.value ?? title);
      return (
        <ThemeTabItem key={value} value={value} label={title}>
          {child.props.children}
        </ThemeTabItem>
      );
    });

  return <ThemeTabs>{items}</ThemeTabs>;
}

export function Tab({ title, children }) {
  return <>{children}</>;
}

function Callout({ tone, children }) {
  const WarningIcon = tone === "warning" ? TriangleAlert : Info;
  return (
    <aside className={`${styles.callout} ${styles[tone]}`}>
      <WarningIcon className={styles.calloutIcon} size={19} aria-hidden="true" />
      <div className={styles.calloutBody}>{children}</div>
    </aside>
  );
}

export function Note({ children }) {
  return <Callout tone="note">{children}</Callout>;
}

export function Warning({ children }) {
  return <Callout tone="warning">{children}</Callout>;
}
