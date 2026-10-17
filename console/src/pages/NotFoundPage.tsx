import { Link } from "react-router-dom";
import { useDocumentTitle } from "../lib/useDocumentTitle";

export function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <>
      <h1>Page not found</h1>
      <p>
        This console page does not exist. <Link to="/">Go to the start page</Link>.
      </p>
    </>
  );
}
