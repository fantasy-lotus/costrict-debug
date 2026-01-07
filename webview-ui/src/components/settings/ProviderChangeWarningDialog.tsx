import React from "react"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@src/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"

interface ProviderChangeWarningDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onConfirm: () => void
}

export const ProviderChangeWarningDialog: React.FC<ProviderChangeWarningDialogProps> = ({
	open,
	onOpenChange,
	onConfirm,
}) => {
	const { t } = useAppTranslation()

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("settings:providerChangeWarning.title")}</AlertDialogTitle>
					<AlertDialogDescription>
						<div className="space-y-2">
							<p>{t("settings:providerChangeWarning.description")}</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{t("settings:providerChangeWarning.cancelButton")}</AlertDialogCancel>
					<AlertDialogAction onClick={onConfirm}>
						{t("settings:providerChangeWarning.confirmButton")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
