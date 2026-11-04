import { LuExternalLink } from 'react-icons/lu';
import { PI_PACKAGES_URL } from '../../../../../shared/pi-packages';
import { actions } from '../../../apis/actions';
import { Button } from '../button';

/**
 * The Discover tab, not implemented yet.
 *
 * pi's gallery at {@link PI_PACKAGES_URL} is a website, not an API Amulet speaks today, and inventing
 * a registry query here would be a second, worse copy of it. So the tab is honest about what it is and
 * sends the human where the packages actually are — the same page `pi install` copies its source from.
 */
export function DiscoverPanel() {
  return (
    <div className="pk-discover">
      <p className="pk-empty">
        Browsing the pi package gallery inside Amulet is not built yet.
      </p>
      <p className="pk-discover-note">
        Until it is, open the gallery, copy a package name, and install it from
        the Installed tab — its install button takes the same sources the
        gallery lists.
      </p>
      <Button
        variant="secondary"
        startIcon={LuExternalLink}
        onClick={() => actions.openExternal(PI_PACKAGES_URL)}>
        Open {PI_PACKAGES_URL.replace(/^https:\/\//, '')}
      </Button>
    </div>
  );
}
