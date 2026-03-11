import React from 'react';
import { FeedItem } from '../types';
import { ObservationCard } from './ObservationCard';
import { SummaryCard } from './SummaryCard';

interface ProjectColumnProps {
  project: string;
  items: FeedItem[];
  onViewInFeed: (project: string) => void;
}

/** Extract a short display name from a full project path */
function displayName(project: string): string {
  // Strip trailing slashes, take last segment
  const cleaned = project.replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || project;
}

export function ProjectColumn({ project, items, onViewInFeed }: ProjectColumnProps) {
  return (
    <div className="project-column">
      <div className="project-column-header">
        <div className="project-column-name" title={project}>
          {displayName(project)}
        </div>
        <span className="project-column-count">{items.length}</span>
      </div>

      <div className="project-column-items">
        {items.map(item => {
          const key = `${item.itemType}-${item.id}`;
          if (item.itemType === 'observation') {
            return <ObservationCard key={key} observation={item} compact />;
          } else if (item.itemType === 'summary') {
            return <SummaryCard key={key} summary={item} compact />;
          }
          return null;
        })}
        {items.length === 0 && (
          <div className="project-column-empty">No items yet</div>
        )}
      </div>

      <div className="project-column-footer">
        <button
          className="project-column-link"
          onClick={() => onViewInFeed(project)}
        >
          View in Feed
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
    </div>
  );
}
