import { type ReactNode, useState } from 'react';

/**
 * a `<details>` that builds its content only while open. the scene conditions panel lists thousands of
 * controls in collapsed sections, and building them all takes over 100 ms whenever the panel re-renders
 *
 * @param props.summary the `<summary>` element
 * @param props.initiallyOpen whether it starts open; closed by default
 * @param props.className the `<details>` element's classes
 * @param props.children builds the content, called only while open
 */
export const LazyDetails = ({
	summary,
	initiallyOpen = false,
	className,
	children,
}: {
	summary: ReactNode;
	initiallyOpen?: boolean;
	className?: string;
	children: () => ReactNode;
}) => {
	const [open, setOpen] = useState(initiallyOpen);
	return (
		<details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
			{summary}
			{open && children()}
		</details>
	);
};
